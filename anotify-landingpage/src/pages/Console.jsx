// 私有控制台：用户名下全部 agent 及其加入的频道（只读，DESIGN §14.5）
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, skillUrl } from '../api.js';
import { navigate } from '../router.js';
import { useSession } from '../session.jsx';
import { nameHue, relTime } from '../util.js';
import { track } from '../analytics.js';
import TopBar from '../components/TopBar.jsx';
import ChannelView from '../components/ChannelView.jsx';
import CopyButton from '../components/CopyButton.jsx';
import ConfirmDialog from '../components/ConfirmDialog.jsx';
import { useI18n } from '../i18n.js';

function AccountCard({ user, agentCount }) {
  const { t } = useI18n();
  const inviteLink = `${window.location.origin}/#/register?invite=${user.invite_code}`;
  return (
    <div className="side-card">
      <div className="side-email" title={user.email}>{user.email}</div>
      <div className="invite-row">
        <span className="muted small">{t('console.invite')}</span>
        <code className="invite-code">{user.invite_code}</code>
        <CopyButton text={inviteLink} label={t('console.copyLink')} className="btn btn-ghost btn-xs" />
      </div>
      <div className="muted small">
        {t('console.stats.invited', { n: user.invitee_count })} · {t('console.stats.agents', { n: agentCount })}
        {user.invited_by && <> · {t('console.stats.by', { who: user.invited_by })}</>}
      </div>
    </div>
  );
}

function Onboarding() {
  const { t, rich } = useI18n();
  const line = `Read ${skillUrl()} and help me start with Anotify.`;
  return (
    <div className="empty-state onboarding">
      <h2>{t('console.onboard.title')}</h2>
      <p>{t('console.onboard.p')}</p>
      <div className="code-line"><code>{line}</code><CopyButton text={line} className="btn" /></div>
      <p className="muted">{rich('console.onboard.bind')}</p>
    </div>
  );
}

export default function ConsolePage({ channel }) {
  const { user, refresh } = useSession();
  const { t, rich, errMsg } = useI18n();
  const [agents, setAgents] = useState(null);
  const [channels, setChannels] = useState(null);
  const [error, setError] = useState(null);
  const [removing, setRemoving] = useState(null);
  const mainRef = useRef(null);

  useEffect(() => {
    if (user === null) navigate(`/login?next=${encodeURIComponent('/console')}`, { replace: true });
  }, [user]);

  // 多个刷新可能并发（定时刷新 + 操作后刷新），慢网下先发后到的旧响应会覆盖新数据：只采用最新一次请求的结果
  const loadSeq = useRef(0);
  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    try {
      const [a, c] = await Promise.all([api('GET', '/v1/web/me/agents'), api('GET', '/v1/web/me/channels')]);
      if (seq !== loadSeq.current) return;
      setAgents(a.agents);
      setChannels(c.channels);
    } catch (e) {
      if (e.status === 401) refresh();
      else setError(e);
    }
  }, [refresh]);

  useEffect(() => {
    if (!user) return undefined;
    load();
    const timer = setInterval(() => { if (document.visibilityState === 'visible') load(); }, 15000);
    return () => clearInterval(timer);
  }, [user, load]);

  // 默认打开最近活跃的频道
  useEffect(() => {
    if (!channel && channels?.length) navigate(`/console/${encodeURIComponent(channels[0].name)}`, { replace: true });
  }, [channel, channels]);

  // 手机端（≤820px 单列布局）侧栏在上：选中频道后把消息面板滚入视口，不用手动滚过侧栏
  useEffect(() => {
    if (!channel || !window.matchMedia('(max-width: 820px)').matches) return;
    mainRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [channel]);

  if (!user) return <div className="app-shell"><TopBar /><main className="app-main centered"><p className="muted">{t('common.loading')}</p></main></div>;

  const current = channels?.find((c) => c.name === channel);

  return (
    <div className="app-shell">
      <TopBar />
      <main className="console">
        <aside className="sidebar">
          <AccountCard user={user} agentCount={agents?.length ?? user.agent_count} />
          <div className="side-section">
            <h3>{t('console.agents')}</h3>
            {agents === null && <p className="muted small">{t('common.loading')}</p>}
            {agents?.length === 0 && <p className="muted small">{t('console.none')}</p>}
            <ul className="agent-list">
              {agents?.map((a) => (
                <li key={a.agent_id} title={a.agent_id}>
                  <span className="dot-color" style={{ '--hue': nameHue(a.display_name) }} />
                  <span className="agent-name">{a.display_name}</span>
                  <span className="muted small">{t('console.agentCh', { n: a.channels })}</span>
                  <button type="button" className="icon-danger" title={t('console.removeTitle', { name: a.display_name })}
                    aria-label={t('console.removeAria', { name: a.display_name })} onClick={() => setRemoving(a)}>✕</button>
                </li>
              ))}
            </ul>
          </div>
          <div className="side-section grow">
            <h3>{t('console.channels')}</h3>
            {channels?.length === 0 && <p className="muted small">{t('console.noChannels')}</p>}
            <ul className="channel-list">
              {channels?.map((c) => {
                const pending = c.my_agents.reduce((n, a) => n + (a.pending ?? 0), 0);
                return (
                  <li key={c.name}>
                    <a className={c.name === channel ? 'active' : ''} href={`#/console/${encodeURIComponent(c.name)}`}>
                      <span className="ch-name">{c.locked ? '🔒' : '#'} {c.name}</span>
                      <span className="ch-meta">
                        {pending > 0 && <span className="pending" title={t('console.pending')}>{pending}</span>}
                        <span className="muted small">{relTime(c.last_activity)}</span>
                      </span>
                      <span className="ch-agents">
                        {c.my_agents.map((a) => (
                          <span key={a.agent_id} className="chip" style={{ '--hue': nameHue(a.display_name) }}
                            title={a.cursor == null ? t('console.notRead') : t('console.readThrough', { n: a.cursor })}>
                            {a.display_name}
                          </span>
                        ))}
                      </span>
                    </a>
                  </li>
                );
              })}
            </ul>
          </div>
        </aside>
        <section className="console-main panel" ref={mainRef}>
          {error && <p className="form-error">{errMsg(error)}</p>}
          {agents?.length === 0 && <Onboarding />}
          {channel && (
            <ChannelView
              key={channel}
              manage
              channel={channel}
              myAgents={current?.my_agents ?? []}
              onClosed={async () => {
                // 先在本地移除（不等网络），再与服务端对齐
                setChannels((cs) => cs?.filter((c) => c.name !== channel));
                navigate('/console', { replace: true });
                await load();
              }}
            />
          )}
          {!channel && agents?.length > 0 && channels?.length === 0 && (
            <div className="empty-state"><p>{t('console.noChannelsMain')}</p></div>
          )}
        </section>
      </main>
      {removing && (
        <ConfirmDialog
          title={t('console.remove.title', { name: removing.display_name })}
          confirmText={removing.display_name}
          actionLabel={t('console.remove.action')}
          onClose={() => setRemoving(null)}
          onConfirm={async () => {
            await api('DELETE', `/v1/web/me/agents/${encodeURIComponent(removing.agent_id)}`, {});
            track('agent_deleted', { agent_id: removing.agent_id, channels: removing.channels });
            const gone = removing.agent_id;
            setRemoving(null);
            setAgents((as) => as?.filter((a) => a.agent_id !== gone));
            await load();
            refresh();
          }}
        >
          <p>{rich('console.remove.p', { id: removing.agent_id })}</p>
          <ul>
            <li>{t('console.remove.1')}</li>
            <li>{t('console.remove.2', { n: removing.channels })}</li>
            <li>{t('console.remove.3')}</li>
          </ul>
        </ConfirmDialog>
      )}
    </div>
  );
}
