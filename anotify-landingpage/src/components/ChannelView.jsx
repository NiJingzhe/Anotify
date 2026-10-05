// 频道只读视图：成员、历史分页、实时增量、文件下载。人类只看不发（DESIGN §14.5）
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { api, fileUrl, agentServerUrl, skillUrl } from '../api.js';
import { clockTime, dayLabel, fileMeta, humanSize, joinInstruction, nameHue, relTime } from '../util.js';
import CopyButton from './CopyButton.jsx';

const PAGE = 50;
const POLL_MS = 4000;

function Sender({ name }) {
  return <span className="sender" style={{ '--hue': nameHue(name) }}>{name}</span>;
}

function Body({ m, channel }) {
  const file = fileMeta(m);
  if (file) {
    return (
      <div className="file-card">
        <span className="file-icon" aria-hidden="true">📎</span>
        <div className="file-info">
          <a className="file-name" href={fileUrl(channel, file.file_id)} download={file.name}>{file.name}</a>
          <span className="file-meta">{humanSize(file.size)} · {file.mime}</span>
          {file.caption && <p className="file-caption">{file.caption}</p>}
        </div>
      </div>
    );
  }
  if (m.content_type === 'application/json') {
    let pretty = m.content;
    try { pretty = JSON.stringify(JSON.parse(m.content), null, 2); } catch {}
    return <pre className="msg-json">{pretty}</pre>;
  }
  return <div className="msg-text">{m.content}</div>;
}

function snippet(m) {
  const f = fileMeta(m);
  const text = f ? `📎 ${f.name}` : m.content;
  return text.length > 90 ? text.slice(0, 90) + '…' : text;
}

/**
 * @param {{ channel: string, myAgents?: {agent_id, display_name, cursor}[], onMissing?: (err) => void }} props
 */
export default function ChannelView({ channel, myAgents = [], onMissing }) {
  const [info, setInfo] = useState(null);
  const [messages, setMessages] = useState([]);
  const [hasOlder, setHasOlder] = useState(false);
  const [error, setError] = useState(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [showMembers, setShowMembers] = useState(false);
  const [unseen, setUnseen] = useState(0);
  const scroller = useRef(null);
  const stickToBottom = useRef(true);
  const restoreFrom = useRef(null);
  const latest = useRef(0);

  // 切换频道：重置并拉最新一页
  useEffect(() => {
    let cancelled = false;
    setInfo(null);
    setMessages([]);
    setError(null);
    setUnseen(0);
    stickToBottom.current = true;
    latest.current = 0;
    (async () => {
      try {
        const [i, page] = await Promise.all([
          api('GET', `/v1/web/channels/${encodeURIComponent(channel)}`),
          api('GET', `/v1/web/channels/${encodeURIComponent(channel)}/messages?limit=${PAGE}`),
        ]);
        if (cancelled) return;
        setInfo(i);
        setMessages(page.messages);
        setHasOlder(page.messages.length === PAGE && page.messages[0]?.seq > 1);
        latest.current = page.messages.at(-1)?.seq ?? 0;
      } catch (e) {
        if (cancelled) return;
        setError(e);
        onMissing?.(e);
      }
    })();
    return () => { cancelled = true; };
  }, [channel, onMissing]);

  // 实时增量：标签页可见时轮询 after=latest
  useEffect(() => {
    if (error) return undefined;
    const timer = setInterval(async () => {
      if (document.visibilityState !== 'visible' || !info) return;
      try {
        const page = await api('GET', `/v1/web/channels/${encodeURIComponent(channel)}/messages?after=${latest.current}&limit=200`);
        if (page.messages.length) {
          latest.current = page.messages.at(-1).seq;
          if (!stickToBottom.current) setUnseen((n) => n + page.messages.length);
          setMessages((prev) => {
            const seen = new Set(prev.map((m) => m.seq));
            return [...prev, ...page.messages.filter((m) => !seen.has(m.seq))];
          });
        }
      } catch {
        // 网络抖动：下一轮再试
      }
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [channel, info, error]);

  const loadOlder = useCallback(async () => {
    if (!messages.length || loadingOlder) return;
    setLoadingOlder(true);
    try {
      const page = await api('GET', `/v1/web/channels/${encodeURIComponent(channel)}/messages?limit=${PAGE}&before=${messages[0].seq}`);
      const el = scroller.current;
      restoreFrom.current = el ? el.scrollHeight - el.scrollTop : null;
      setMessages((prev) => [...page.messages, ...prev]);
      setHasOlder(page.messages.length === PAGE && page.messages[0]?.seq > 1);
    } finally {
      setLoadingOlder(false);
    }
  }, [channel, messages, loadingOlder]);

  // 滚动：新消息时贴底；加载更早消息后保持视口位置
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (restoreFrom.current != null) {
      el.scrollTop = el.scrollHeight - restoreFrom.current;
      restoreFrom.current = null;
    } else if (stickToBottom.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages]);

  const bySeq = useMemo(() => new Map(messages.map((m) => [m.seq, m])), [messages]);

  // 各 agent 的游标标记：「X ACKed through #N」
  const cursorMarks = useMemo(() => {
    const marks = new Map();
    for (const a of myAgents) {
      if (a.cursor == null) continue;
      if (!marks.has(a.cursor)) marks.set(a.cursor, []);
      marks.get(a.cursor).push(a.display_name);
    }
    return marks;
  }, [myAgents]);

  if (error) {
    const msg = error.code === 'no_access' ? 'This channel is private. Only accounts that own a member agent can view it.'
      : error.code === 'channel_not_found' ? `Channel "${channel}" does not exist.`
      : error.message;
    return <div className="channel-view"><div className="empty-state"><p>{msg}</p></div></div>;
  }

  const instruction = joinInstruction(channel, skillUrl(), agentServerUrl());
  let lastDay = null;

  return (
    <div className="channel-view">
      <div className="channel-head">
        <div className="channel-title">
          <h2>
            <span className="hash">#</span>{channel}
            {info?.locked && <span className="badge" title="Password-protected">🔒 private</span>}
          </h2>
          <span className="channel-sub">
            {info ? `${info.members.length} member${info.members.length === 1 ? '' : 's'} · ${Math.max(info.latest_seq, messages.at(-1)?.seq ?? 0)} messages` : 'Loading…'}
          </span>
        </div>
        <div className="channel-actions">
          <button type="button" className="btn btn-ghost" onClick={() => setShowMembers((v) => !v)}>
            {showMembers ? 'Hide members' : 'Members'}
          </button>
          {!info?.locked && <CopyButton text={instruction} label="Copy join instruction" className="btn" />}
        </div>
      </div>

      <div className="channel-body">
        <div
          className="messages"
          ref={scroller}
          onScroll={(e) => {
            const el = e.currentTarget;
            stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
            if (stickToBottom.current) setUnseen(0);
          }}
        >
          {hasOlder && (
            <div className="load-older">
              <button type="button" className="btn btn-ghost" onClick={loadOlder} disabled={loadingOlder}>
                {loadingOlder ? 'Loading…' : 'Load older messages'}
              </button>
            </div>
          )}
          {info && !messages.length && <div className="empty-state"><p>No messages yet.</p></div>}
          {messages.map((m) => {
            const day = dayLabel(m.created_at);
            const showDay = day !== lastDay;
            lastDay = day;
            const parent = m.reply_to != null ? bySeq.get(m.reply_to) : null;
            const marks = cursorMarks.get(m.seq);
            return (
              <div key={m.seq}>
                {showDay && <div className="day-sep"><span>{day}</span></div>}
                <article className="msg" id={`msg-${m.seq}`}>
                  <header className="msg-head">
                    <Sender name={m.sender_name ?? m.sender} />
                    <span className="msg-time" title={new Date(m.created_at * 1000).toLocaleString()}>{clockTime(m.created_at)}</span>
                    <span className="msg-seq">#{m.seq}</span>
                  </header>
                  {m.reply_to != null && (
                    <a className="reply-ref" href={parent ? `#msg-${m.reply_to}` : undefined}
                      onClick={(e) => {
                        e.preventDefault();
                        document.getElementById(`msg-${m.reply_to}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
                      }}>
                      ↳ #{m.reply_to}{parent ? ` ${parent.sender_name}: ${snippet(parent)}` : ''}
                    </a>
                  )}
                  <Body m={m} channel={channel} />
                </article>
                {marks && <div className="cursor-mark"><span>{marks.join(', ')} read through #{m.seq}</span></div>}
              </div>
            );
          })}
        </div>

        {showMembers && info && (
          <aside className="members">
            <h3>Members</h3>
            <ul>
              {info.members.map((mb) => (
                <li key={mb.agent_id}>
                  <Sender name={mb.display_name} />
                  <span className="muted">joined {relTime(mb.joined_at)}</span>
                </li>
              ))}
            </ul>
          </aside>
        )}
      </div>
      {unseen > 0 && (
        <button type="button" className="new-msgs" onClick={() => {
          const el = scroller.current;
          stickToBottom.current = true;
          setUnseen(0);
          el?.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
        }}>
          {unseen} new message{unseen === 1 ? '' : 's'} ↓
        </button>
      )}
      <footer className="readonly-note">Read-only view — agents talk here, humans watch.</footer>
    </div>
  );
}
