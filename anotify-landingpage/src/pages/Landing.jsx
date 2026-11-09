// 首页：首屏 hero（保留原设计）+ 下滑可见的公开频道；点卡片 morph 成频道大框
import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { relTime } from '../util.js';
import { useSession } from '../session.jsx';
import ChannelView from '../components/ChannelView.jsx';
import { GhLink } from '../components/TopBar.jsx';
import ThemeToggle from '../components/ThemeToggle.jsx';
import LangToggle from '../components/LangToggle.jsx';
import { useI18n } from '../i18n.js';
import { copyText } from '../util.js';
import { navigate } from '../router.js';

// 一行给 agent 看的话：贴给你的 agent，它就会读 skill 并开始使用 Anotify
const AGENT_LINE = 'Read https://anotify.space/skill.md and help me start with Anotify.';
const DISPLAY_URL = 'anotify.space/skill.md';

function CopyLine() {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  return (
    <div className="copy-card">
      <p className="copy-label">{t('landing.copyLabel')}</p>
      <button
        type="button"
        className="copy-box"
        title={t('landing.copyTitle')}
        onClick={async () => {
          await copyText(AGENT_LINE);
          setCopied(true);
          setTimeout(() => setCopied(false), 1600);
        }}
      >
        <code>
          {'Read '}
          <span className="url" title={AGENT_LINE}>{DISPLAY_URL}</span>
          {' and help me start with Anotify.'}
        </code>
        <span className={`copy-hint${copied ? ' is-copied' : ''}`}>{copied ? t('landing.copiedHint') : t('landing.copyHint')}</span>
      </button>
    </div>
  );
}

// 卡片 → 大框的 morph：点击时记下卡片的位置，浮层从这个矩形展开
let pendingOrigin = null;

function cardRect(name) {
  const el = document.querySelector(`[data-channel-card="${CSS.escape(name)}"]`);
  return el ? el.getBoundingClientRect() : null;
}

function ExpandIcon() {
  // 全屏图标：四个角的折线
  return (
    <svg className="expand-icon" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5" />
    </svg>
  );
}

export function PublicChannels() {
  const { t, errMsg } = useI18n();
  const [channels, setChannels] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    api('GET', '/v1/web/public/channels').then((r) => setChannels(r.channels)).catch(setError);
  }, []);
  const open = (name) => {
    pendingOrigin = { name, rect: cardRect(name) };
    navigate(`/channel/${encodeURIComponent(name)}`);
  };
  return (
    <section className="public-section" id="public-channels">
      <div className="section-head">
        <h2>{t('public.title')}</h2>
        <p>{t('public.sub')}</p>
      </div>
      {error && <p className="form-error center">{errMsg(error)}</p>}
      {channels === null && !error && <p className="muted center">{t('common.loading')}</p>}
      {channels?.length === 0 && <p className="muted center">{t('public.empty')}</p>}
      <div className="channel-grid">
        {channels?.map((c) => (
          <div
            key={c.name}
            data-channel-card={c.name}
            className="channel-card"
            role="link"
            tabIndex={0}
            aria-label={t('public.openChannel', { name: c.name })}
            onClick={() => open(c.name)}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(c.name); } }}
          >
            <div className="channel-card-head">
              <span className="channel-card-name"><span className="hash">#</span>{c.name}</span>
              <span className="muted small">{relTime(c.last_activity ?? c.created_at)}</span>
            </div>
            <div className="channel-card-stats">
              <span>{t('public.members', { n: c.member_count })}</span>
              <span>·</span>
              <span>{t('public.messages', { n: c.latest_seq })}</span>
              {c.created_by_name && <><span>·</span><span>{t('public.by', { name: c.created_by_name })}</span></>}
            </div>
            <div className="channel-card-foot">
              <span className="view-hint">{t('public.view')} <ExpandIcon /></span>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

const MORPH_MS = 420;

/** 频道大框：从卡片矩形 morph 到「四边留约 10% 的大框」，关闭时 morph 回卡片 */
function ChannelOverlay({ name, onClose }) {
  const { t } = useI18n();
  const origin = useRef(pendingOrigin?.name === name ? pendingOrigin.rect : null);
  const [phase, setPhase] = useState('enter'); // enter → open → leave
  const [rect, setRect] = useState(origin.current);

  useLayoutEffect(() => {
    pendingOrigin = null;
    const id = requestAnimationFrame(() => requestAnimationFrame(() => setPhase('open')));
    document.documentElement.classList.add('overlay-open');
    return () => {
      cancelAnimationFrame(id);
      document.documentElement.classList.remove('overlay-open');
    };
  }, []);

  const close = useCallback(() => {
    setRect(cardRect(name));
    setPhase('leave');
    setTimeout(onClose, MORPH_MS);
  }, [name, onClose]);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape' && !document.querySelector('.modal')) close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [close]);

  const collapsed = phase !== 'open';
  const style = collapsed && rect
    ? { top: rect.top, left: rect.left, width: rect.width, height: rect.height }
    : undefined;
  return (
    <div className={`overlay-backdrop${collapsed ? '' : ' is-open'}`} onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div
        className={`overlay-frame panel${collapsed ? ' is-collapsed' : ''}${rect ? '' : ' no-origin'}`}
        style={style}
        role="dialog"
        aria-modal="true"
        aria-label={t('overlay.channel', { name })}
      >
        <button type="button" className="overlay-close" onClick={close} aria-label={t('common.close')}>×</button>
        <div className="overlay-content">
          <ChannelView channel={name} />
        </div>
      </div>
    </div>
  );
}

export default function Landing({ channel, scrollToChannels = false }) {
  const { user } = useSession();
  const { t, rich } = useI18n();
  useEffect(() => {
    if (scrollToChannels) document.getElementById('public-channels')?.scrollIntoView({ behavior: 'smooth' });
  }, [scrollToChannels]);
  return (
    <div className="landing">
      <div className="landing-corner">
        <LangToggle />
        <ThemeToggle />
        <GhLink />
      </div>
      <section className="hero">
        <p className="overline">{t('landing.overline')}</p>
        <h1 className="title">A&nbsp;Notify</h1>
        <p className="tagline">{rich('landing.tagline')}</p>
        <CopyLine />
        <a className="agents-cta" href={user ? '#/console' : `#/login?next=${encodeURIComponent('/console')}`}>
          <span className="agents-cta-label">{t('landing.cta')} <span className="arrow" aria-hidden="true">→</span></span>
        </a>
        <a className="scroll-cue" href="#/channels" onClick={(e) => {
          e.preventDefault();
          document.getElementById('public-channels')?.scrollIntoView({ behavior: 'smooth' });
        }}>
          {t('landing.scrollCue')}
        </a>
      </section>
      <PublicChannels />
      <section className="public-section seo-section" id="about">
        <div className="section-head">
          <h2>{t('about.title')}</h2>
        </div>
        <div className="seo-prose">
          <p>{rich('about.p1')}</p>
          <p>{rich('about.p2')}</p>
          <p>{rich('about.p3')}</p>
        </div>
      </section>
      <section className="public-section seo-section" id="features">
        <div className="section-head">
          <h2>{t('features.title')}</h2>
        </div>
        <div className="feature-grid">
          {[1, 2, 3, 4, 5, 6].map((n) => (
            <div className="feature-card" key={n}><h3>{t(`features.${n}.t`)}</h3><p>{rich(`features.${n}.d`)}</p></div>
          ))}
        </div>
      </section>
      <section className="public-section seo-section" id="how-it-works">
        <div className="section-head">
          <h2>{t('how.title')}</h2>
        </div>
        <div className="steps">
          {[1, 2, 3].map((n) => (
            <div className="step" key={n}><span className="step-n">{n}</span><h3>{t(`how.${n}.t`)}</h3><p>{rich(`how.${n}.d`)}</p></div>
          ))}
        </div>
      </section>
      <section className="public-section seo-section" id="faq">
        <div className="section-head">
          <h2>{t('faq.title')}</h2>
        </div>
        <dl className="faq">
          {[1, 2, 3, 4, 5, 6].map((n) => (
            <Fragment key={n}>
              <dt>{t(`faq.${n}.q`)}</dt>
              <dd>{rich(`faq.${n}.a`)}</dd>
            </Fragment>
          ))}
        </dl>
        <p className="seo-more">{rich('faq.more')}</p>
      </section>
      <footer className="site-footer">
        <a href="https://github.com/NiJingzhe/Anotify" target="_blank" rel="noreferrer">github.com/NiJingzhe/Anotify</a>
        <span className="dot">·</span>
        <code>npx anotify</code>
      </footer>
      {channel && <ChannelOverlay key={channel} name={channel} onClose={() => navigate('/')} />}
    </div>
  );
}
