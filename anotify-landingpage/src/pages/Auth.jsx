// 登录 / 注册 / 邮箱验证
import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { navigate, rememberNext, takeNext } from '../router.js';
import { useSession } from '../session.jsx';
import { track, identifyUser } from '../analytics.js';
import TopBar from '../components/TopBar.jsx';
import { useI18n } from '../i18n.js';

function AuthShell({ title, subtitle, children }) {
  return (
    <div className="app-shell">
      <TopBar />
      <main className="app-main centered">
        <div className="panel auth-panel">
          <h1 className="auth-title">{title}</h1>
          {subtitle && <p className="auth-sub">{subtitle}</p>}
          {children}
        </div>
      </main>
    </div>
  );
}

/** 与服务端一致的密码策略：≥ 8 位，大写 / 小写 / 数字 / 符号至少两类 */
export function passwordChecks(pw) {
  const classes = [/[A-Z]/, /[a-z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) => re.test(pw)).length;
  return { length: [...pw].length >= 8, classes: classes >= 2 };
}

function ResendButton({ email }) {
  const { t, errMsg } = useI18n();
  const [state, setState] = useState('idle');
  const [msg, setMsg] = useState('');
  const [cooldown, setCooldown] = useState(0);
  useEffect(() => {
    if (!cooldown) return undefined;
    const timer = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(timer);
  }, [cooldown]);
  return (
    <div className="resend">
      <button
        type="button"
        className="btn btn-ghost"
        disabled={state === 'busy' || cooldown > 0}
        onClick={async () => {
          setState('busy');
          try {
            await api('POST', '/v1/auth/resend', { email });
            setMsg(t('auth.resend.sent'));
            setCooldown(60);
          } catch (e) {
            setMsg(errMsg(e));
          } finally {
            setState('idle');
          }
        }}
      >
        {cooldown ? t('auth.resend.cooldown', { s: cooldown }) : t('auth.resend.btn')}
      </button>
      {msg && <p className="muted small">{msg}</p>}
    </div>
  );
}

export function LoginPage({ query }) {
  const { setUser } = useSession();
  const { t, rich, errMsg } = useI18n();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (query.next) rememberNext(query.next); }, [query.next]);

  return (
    <AuthShell title={t('login.title')} subtitle={t('login.sub')}>
      <form
        className="form"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          try {
            setUser(await api('POST', '/v1/auth/login', { email, password }));
            track('login_success');
            navigate(takeNext(), { replace: true });
          } catch (err) {
            setError(err);
          } finally {
            setBusy(false);
          }
        }}
      >
        <label>{t('auth.email')}<input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></label>
        <label>{t('auth.password')}<input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} /></label>
        {error && <p className="form-error">{errMsg(error)}</p>}
        {error?.code === 'email_not_verified' && <ResendButton email={email} />}
        <button className="btn btn-primary" disabled={busy}>{busy ? t('login.busy') : t('login.submit')}</button>
      </form>
      <p className="auth-alt">{rich('login.noAccount')}</p>
    </AuthShell>
  );
}

export function RegisterPage({ query }) {
  const { t, rich, errMsg } = useI18n();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [invite, setInvite] = useState(query.invite ?? '');
  const [showPw, setShowPw] = useState(false);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [sentTo, setSentTo] = useState(null);
  const [config, setConfig] = useState(null);
  const checks = useMemo(() => passwordChecks(password), [password]);
  useEffect(() => { if (query.next) rememberNext(query.next); }, [query.next]);
  useEffect(() => { api('GET', '/v1/auth/config').then(setConfig).catch(() => {}); }, []);

  if (sentTo) {
    return (
      <AuthShell title={t('sent.title')} subtitle={t('sent.sub', { email: sentTo })}>
        <div className="spam-note" role="note">
          <span className="spam-emoji" aria-hidden="true">🕵️</span>
          <span>{rich('sent.spam')}</span>
        </div>
        <p className="muted">{t('sent.open')}</p>
        <ResendButton email={sentTo} />
        <p className="auth-alt">{rich('sent.back')}</p>
      </AuthShell>
    );
  }

  const full = config && config.daily_signup_remaining === 0;
  return (
    <AuthShell title={t('register.title')} subtitle={t('register.sub')}>
      {full && (
        <div className="notice">
          {t('register.full', { limit: config.daily_signup_limit })}
        </div>
      )}
      <form
        className="form"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!checks.length || !checks.classes) return;
          setBusy(true);
          setError(null);
          try {
            const r = await api('POST', '/v1/auth/register', { email, password, invite_code: invite.trim() || undefined });
            track('signup_email_sent', { with_invite: !!invite.trim() });
            setSentTo(r.email);
          } catch (err) {
            setError(err);
          } finally {
            setBusy(false);
          }
        }}
      >
        <label>{t('auth.email')}<input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></label>
        <label>
          {t('auth.password')}
          <span className="pw-wrap">
            <input type={showPw ? 'text' : 'password'} autoComplete="new-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
            <button type="button" className="linklike small" onClick={() => setShowPw((v) => !v)}>{showPw ? t('register.hide') : t('register.show')}</button>
          </span>
        </label>
        <ul className="pw-checks">
          <li className={checks.length ? 'ok' : ''}>{t('register.check.length')}</li>
          <li className={checks.classes ? 'ok' : ''}>{t('register.check.classes')}</li>
        </ul>
        <label>
          <span>{t('register.invite')} <span className="muted small">{t('register.optional')}</span></span>
          <input value={invite} onChange={(e) => setInvite(e.target.value.toUpperCase())} maxLength={9} placeholder={t('register.invitePlaceholder')} />
        </label>
        {error && <p className={`form-error${error.code === 'daily_signup_limit' ? ' big' : ''}`}>{errMsg(error)}</p>}
        <button className="btn btn-primary" disabled={busy || full || !checks.length || !checks.classes}>
          {busy ? t('register.busy') : t('register.submit')}
        </button>
        {config && !full && <p className="muted small center">{t('register.left', { n: config.daily_signup_remaining })}</p>}
      </form>
      <p className="auth-alt">{rich('register.haveAccount')}</p>
    </AuthShell>
  );
}

export function VerifyPage({ query }) {
  const { setUser } = useSession();
  const { t, rich, errMsg } = useI18n();
  const [error, setError] = useState(null);
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return; // StrictMode 下 effect 会跑两次；token 只能用一次
    started.current = true;
    api('POST', '/v1/auth/verify', { token: query.token ?? '' })
      .then((u) => {
        track('signup_verified');
        identifyUser(u.user_id ?? u.id, { email: u.email });
        setUser(u);
        navigate(takeNext(), { replace: true });
      })
      .catch(setError);
  }, [query.token, setUser]);
  return (
    <AuthShell title={error ? t('verify.failed') : t('verify.busy')}>
      {error ? (
        <>
          <p className="form-error">{errMsg(error)}</p>
          <p className="auth-alt">{rich('verify.links')}</p>
        </>
      ) : <p className="muted">{t('verify.moment')}</p>}
    </AuthShell>
  );
}
