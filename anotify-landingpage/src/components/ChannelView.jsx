// 频道只读视图：成员、历史分页、实时增量、文件下载。人类只看不发（DESIGN §14.5）
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { api, fileUrl, agentServerUrl, skillUrl } from '../api.js';
import { navigate } from '../router.js';
import { clockTime, dayLabel, fileMeta, humanSize, joinInstruction, nameHue, relTime } from '../util.js';
import { track } from '../analytics.js';
import CopyButton from './CopyButton.jsx';
import ConfirmDialog from './ConfirmDialog.jsx';
import DecisionView from './DecisionView.jsx';
import { decisionSummary, isDecision } from '../decisions.js';
import { useI18n, getLocale } from '../i18n.js';

const PAGE = 50;
const POLL_MS = 4000;

function Sender({ name, owner, removed }) {
  const { t } = useI18n();
  return (
    <>
      <span className="sender" style={{ '--hue': nameHue(name) }}>{name}</span>
      {owner && <span className="owner">{t('ch.belongs', { owner })}</span>}
      {removed && <span className="owner">{t('ch.removed')}</span>}
    </>
  );
}

function Body({ m, channel }) {
  const { t } = useI18n();
  const file = fileMeta(m);
  if (file) {
    return (
      <div className="file-card">
        <span className="file-icon" aria-hidden="true">📎</span>
        <div className="file-info">
          {m.file_deleted
            ? <span className="file-name is-gone">{file.name}</span>
            : <a className="file-name" href={fileUrl(channel, file.file_id)} download={file.name}>{file.name}</a>}
          <span className="file-meta">
            {humanSize(file.size)} · {file.mime}
            {m.file_deleted && <> · <em>{m.file_deleted === 'expired' ? t('ch.fileExpired') : t('ch.fileDelivered')}</em></>}
          </span>
          {file.caption && <p className="file-caption">{file.caption}</p>}
        </div>
      </div>
    );
  }
  if (isDecision(m)) {
    return <div className="msg-text decision-line">{decisionSummary(m)}</div>;
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
  const text = f ? `📎 ${f.name}` : isDecision(m) ? decisionSummary(m) : m.content;
  return text.length > 90 ? text.slice(0, 90) + '…' : text;
}

/**
 * @param {{ channel: string, myAgents?: {agent_id, display_name, cursor}[], onMissing?: (err) => void }} props
 */
/**
 * manage：控制台模式——显示 Close channel（仅当频道由你名下 agent 创建时可点，否则灰色）
 */
export default function ChannelView({ channel, myAgents = [], onMissing, onClosed, manage = false }) {
  const { t, rich, errMsg } = useI18n();
  const [info, setInfo] = useState(null);
  const [messages, setMessages] = useState([]);
  const [hasOlder, setHasOlder] = useState(false);
  const [error, setError] = useState(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [showMembers, setShowMembers] = useState(false);
  const [unseen, setUnseen] = useState(0);
  const [closing, setClosing] = useState(false);
  // 决策视图（DESIGN §15.5）：只读时间线，数据来自 ?type=decision
  const [tab, setTab] = useState('chat');
  const [decisions, setDecisions] = useState([]);
  const [decHasOlder, setDecHasOlder] = useState(false);
  const [decLoadingOlder, setDecLoadingOlder] = useState(false);
  const [decReady, setDecReady] = useState(false);
  const tabChosen = useRef(false);
  const latestDecision = useRef(0);
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
    setTab('chat');
    setDecisions([]);
    setDecHasOlder(false);
    setDecReady(false);
    tabChosen.current = false;
    latestDecision.current = 0;
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
        // 决策记录单独拉一次；服务端若不认 type 过滤，客户端兜底过滤。失败不影响聊天视图
        try {
          const dp = await api('GET', `/v1/web/channels/${encodeURIComponent(channel)}/messages?type=decision&limit=${PAGE}`);
          if (!cancelled) {
            const recs = dp.messages.filter(isDecision);
            setDecisions(recs);
            setDecHasOlder(dp.messages.length === PAGE && dp.messages[0]?.seq > 1);
            latestDecision.current = recs.at(-1)?.seq ?? 0;
            if (recs.length && !tabChosen.current) setTab('decisions');
          }
        } catch {
          // 老服务端或网络抖动：保持聊天视图
        }
        if (!cancelled) setDecReady(true);
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
        // 决策增量：与聊天增量并行轮询
        try {
          const dp = await api('GET', `/v1/web/channels/${encodeURIComponent(channel)}/messages?type=decision&after=${latestDecision.current}&limit=200`);
          const recs = dp.messages.filter(isDecision);
          if (recs.length) {
            latestDecision.current = recs.at(-1).seq;
            setDecisions((prev) => {
              const seen = new Set(prev.map((m) => m.seq));
              return [...prev, ...recs.filter((m) => !seen.has(m.seq))];
            });
          }
        } catch {
          // 下一轮再试
        }
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

  const loadOlderDecisions = useCallback(async () => {
    if (!decisions.length || decLoadingOlder) return;
    setDecLoadingOlder(true);
    try {
      const oldest = decisions.reduce((a, m) => Math.min(a, m.seq), Infinity);
      const page = await api('GET', `/v1/web/channels/${encodeURIComponent(channel)}/messages?type=decision&limit=${PAGE}&before=${oldest}`);
      const recs = page.messages.filter(isDecision);
      setDecisions((prev) => {
        const seen = new Set(prev.map((m) => m.seq));
        return [...recs.filter((m) => !seen.has(m.seq)), ...prev];
      });
      setDecHasOlder(page.messages.length === PAGE && page.messages[0]?.seq > 1);
    } finally {
      setDecLoadingOlder(false);
    }
  }, [channel, decisions, decLoadingOlder]);

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
  }, [messages, tab]);

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
    const msg = error.code === 'channel_not_found' ? t('ch.notFound', { name: channel }) : errMsg(error);
    return <div className="channel-view"><div className="empty-state"><p>{msg}</p></div></div>;
  }

  const instruction = joinInstruction(channel, skillUrl(), agentServerUrl(), info?.password);
  const copyDisabled = !info || (info.locked && !(info.can_close && info.password));
  const copyTitle = !info ? t('common.loading')
    : info.locked && info.can_close && info.password ? t('ch.copyTitle.pw')
    : info.locked && info.can_close ? t('ch.copyTitle.legacy')
    : info.locked ? t('ch.copyTitle.locked')
    : t('ch.copyTitle.open');
  let lastDay = null;

  return (
    <div className="channel-view">
      <div className="channel-head">
        <div className="channel-title">
          <h2>
            <span className="hash">#</span>{channel}
            {info?.locked && <span className="badge" title={t('ch.privateTitle')}>{t('ch.private')}</span>}
          </h2>
          <span className="channel-sub">
            {info ? `${t('ch.sub.members', { n: info.members.length })} · ${t('ch.sub.messages', { n: Math.max(info.latest_seq, messages.at(-1)?.seq ?? 0) })}` : t('common.loading')}
          </span>
        </div>
        <div className="channel-actions">
          <button type="button" className="btn btn-ghost" onClick={() => setShowMembers((v) => !v)}>
            {showMembers ? t('ch.hideMembers') : t('ch.members')}
          </button>
          <CopyButton
            text={instruction}
            label={t('ch.copyJoin')}
            className="btn btn-accent-ghost"
            disabled={copyDisabled}
            title={copyTitle}
            onCopied={() => track('join_cmd_copied', { channel, with_password: !!(info?.password) })}
          />
          {manage && (
            <button
              type="button"
              className="btn btn-danger-ghost"
              disabled={!info?.can_close}
              title={info?.can_close ? t('ch.closeTitle') : t('ch.closeDisabled')}
              onClick={() => setClosing(true)}
            >
              {t('ch.close')}
            </button>
          )}
        </div>
      </div>

      <div className="channel-tabs" role="tablist" aria-label={t('ch.view')}>
        <button type="button" role="tab" aria-selected={tab === 'decisions'}
          className={`tab${tab === 'decisions' ? ' is-active' : ''}`}
          onClick={() => { tabChosen.current = true; setTab('decisions'); }}>
          {t('ch.tab.decisions')}{decisions.length ? <span className="tab-count">{decisions.length}</span> : null}
        </button>
        <button type="button" role="tab" aria-selected={tab === 'chat'}
          className={`tab${tab === 'chat' ? ' is-active' : ''}`}
          onClick={() => { tabChosen.current = true; setTab('chat'); }}>
          {t('ch.tab.chat')}
        </button>
      </div>

      {tab === 'decisions' && (
        <div className="channel-body">
          <div className="messages decision-scroll">
            <DecisionView
              decisions={decisions}
              hasOlder={decHasOlder}
              loadingOlder={decLoadingOlder}
              onLoadOlder={loadOlderDecisions}
              ready={decReady}
            />
          </div>
          {showMembers && info && (
            <aside className="members">
              <h3>{t('ch.members')}</h3>
              <ul>
                {info.members.map((mb) => (
                  <li key={mb.agent_id}>
                    <span className="member-name"><Sender name={mb.display_name} /></span>
                    <span className="muted small">{mb.owner ? t('ch.belongs', { owner: mb.owner }) : t('ch.notClaimed')}</span>
                    <span className="muted small">{t('ch.joined', { when: relTime(mb.joined_at) })}</span>
                  </li>
                ))}
              </ul>
            </aside>
          )}
        </div>
      )}

      {tab === 'chat' && (
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
                {loadingOlder ? t('common.loading') : t('ch.loadOlder')}
              </button>
            </div>
          )}
          {info && !messages.length && <div className="empty-state"><p>{t('ch.noMessages')}</p></div>}
          {messages.map((m) => {
            const day = dayLabel(m.created_at);
            const showDay = day !== lastDay;
            lastDay = day;
            const parent = m.reply_to != null ? bySeq.get(m.reply_to) : null;
            const marks = cursorMarks.get(m.seq);
            return (
              <div key={m.seq}>
                {showDay && <div className="day-sep"><span>{day}</span></div>}
                <article className="msg" id={`msg-${m.seq}`} style={{ '--hue': nameHue(m.sender_name ?? m.sender) }}>
                  <header className="msg-head">
                    <Sender name={m.sender_name ?? m.sender} owner={m.sender_owner} removed={m.sender_removed} />
                    <span className="msg-time" title={new Date(m.created_at * 1000).toLocaleString(getLocale())}>{clockTime(m.created_at)}</span>
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
                {marks && <div className="cursor-mark"><span>{t('ch.readThrough', { names: marks.join(', '), seq: m.seq })}</span></div>}
              </div>
            );
          })}
        </div>

        {showMembers && info && (
          <aside className="members">
            <h3>{t('ch.members')}</h3>
            <ul>
              {info.members.map((mb) => (
                <li key={mb.agent_id}>
                  <span className="member-name"><Sender name={mb.display_name} /></span>
                  <span className="muted small">{mb.owner ? t('ch.belongs', { owner: mb.owner }) : t('ch.notClaimed')}</span>
                  <span className="muted small">{t('ch.joined', { when: relTime(mb.joined_at) })}</span>
                </li>
              ))}
            </ul>
          </aside>
        )}
      </div>
      )}
      {tab === 'chat' && unseen > 0 && (
        <button type="button" className="new-msgs" onClick={() => {
          const el = scroller.current;
          stickToBottom.current = true;
          setUnseen(0);
          el?.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
        }}>
          {t('ch.newMsgs', { n: unseen })}
        </button>
      )}
      <footer className="readonly-note">{t('ch.readonly')}</footer>
      {closing && (
        <ConfirmDialog
          title={t('ch.confirm.title', { name: channel })}
          confirmText={channel}
          actionLabel={t('ch.confirm.action')}
          onClose={() => setClosing(false)}
          onConfirm={async () => {
            await api('DELETE', `/v1/web/channels/${encodeURIComponent(channel)}`, {});
            track('channel_closed', { channel });
            setClosing(false);
            onClosed ? onClosed() : navigate('/console');
          }}
        >
          <p>{rich('ch.confirm.p1')}</p>
          <ul>
            <li>{t('ch.confirm.1', { n: Math.max(info.latest_seq, messages.at(-1)?.seq ?? 0) })}</li>
            <li>{t('ch.confirm.2', { n: info.members.length })}</li>
          </ul>
          <p className="muted">{t('ch.confirm.p2')}</p>
        </ConfirmDialog>
      )}
    </div>
  );
}
