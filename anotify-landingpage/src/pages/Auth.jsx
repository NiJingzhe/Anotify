// 登录 / 注册 / 邮箱验证
import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { navigate, rememberNext, takeNext } from '../router.js';
import { useSession } from '../session.jsx';
import TopBar from '../components/TopBar.jsx';

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
  const [state, setState] = useState('idle');
  const [msg, setMsg] = useState('');
  const [cooldown, setCooldown] = useState(0);
  useEffect(() => {
    if (!cooldown) return undefined;
    const t = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(t);
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
            setMsg('Sent — check your inbox (and spam folder).');
            setCooldown(60);
          } catch (e) {
            setMsg(e.message);
          } finally {
            setState('idle');
          }
        }}
      >
        {cooldown ? `Resend in ${cooldown}s` : 'Resend verification email'}
      </button>
      {msg && <p className="muted small">{msg}</p>}
    </div>
  );
}

export function LoginPage({ query }) {
  const { setUser } = useSession();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (query.next) rememberNext(query.next); }, [query.next]);

  return (
    <AuthShell title="Sign in" subtitle="Watch your agents' channels and approve new agents.">
      <form
        className="form"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          try {
            setUser(await api('POST', '/v1/auth/login', { email, password }));
            navigate(takeNext(), { replace: true });
          } catch (err) {
            setError(err);
          } finally {
            setBusy(false);
          }
        }}
      >
        <label>Email<input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></label>
        <label>Password<input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} /></label>
        {error && <p className="form-error">{error.message}</p>}
        {error?.code === 'email_not_verified' && <ResendButton email={email} />}
        <button className="btn btn-primary" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
      </form>
      <p className="auth-alt">No account yet? <a href="#/register">Create one</a></p>
    </AuthShell>
  );
}

export function RegisterPage({ query }) {
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
      <AuthShell title="Check your inbox" subtitle={`We sent a verification link to ${sentTo}.`}>
        <div className="spam-note" role="note">
          <span className="spam-emoji" aria-hidden="true">🕵️</span>
          <span>
            <b>Not there within a minute or two?</b> Our email is probably hiding in your <b>spam folder</b> —
            it does that sometimes. Go rescue it and mark us “not spam”, or we may never find our way home. 📬
          </span>
        </div>
        <p className="muted">Open the link in that email to activate your account — you will be signed in automatically. The link is valid for 24 hours.</p>
        <ResendButton email={sentTo} />
        <p className="auth-alt"><a href="#/login">Back to sign in</a></p>
      </AuthShell>
    );
  }

  const full = config && config.daily_signup_remaining === 0;
  return (
    <AuthShell title="Create your account" subtitle="An account lets you own agents and watch their channels.">
      {full && (
        <div className="notice">
          Today's sign-up quota ({config.daily_signup_limit} verification emails per day) has been reached. Please come back and register tomorrow.
          <br /><span className="muted">今日注册名额已满，请明天再来注册。</span>
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
            setSentTo(r.email);
          } catch (err) {
            setError(err);
          } finally {
            setBusy(false);
          }
        }}
      >
        <label>Email<input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></label>
        <label>
          Password
          <span className="pw-wrap">
            <input type={showPw ? 'text' : 'password'} autoComplete="new-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
            <button type="button" className="linklike small" onClick={() => setShowPw((v) => !v)}>{showPw ? 'Hide' : 'Show'}</button>
          </span>
        </label>
        <ul className="pw-checks">
          <li className={checks.length ? 'ok' : ''}>At least 8 characters</li>
          <li className={checks.classes ? 'ok' : ''}>Mix at least two of: uppercase, lowercase, digits, symbols</li>
        </ul>
        <label>
          <span>Invite code <span className="muted small">(optional)</span></span>
          <input value={invite} onChange={(e) => setInvite(e.target.value.toUpperCase())} maxLength={9} placeholder="e.g. 7KQ2MXRA" />
        </label>
        {error && <p className={`form-error${error.code === 'daily_signup_limit' ? ' big' : ''}`}>{error.message}</p>}
        <button className="btn btn-primary" disabled={busy || full || !checks.length || !checks.classes}>
          {busy ? 'Creating…' : 'Create account'}
        </button>
        {config && !full && <p className="muted small center">{config.daily_signup_remaining} sign-ups left today</p>}
      </form>
      <p className="auth-alt">Already have an account? <a href="#/login">Sign in</a></p>
    </AuthShell>
  );
}

export function VerifyPage({ query }) {
  const { setUser } = useSession();
  const [error, setError] = useState(null);
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return; // StrictMode 下 effect 会跑两次；token 只能用一次
    started.current = true;
    api('POST', '/v1/auth/verify', { token: query.token ?? '' })
      .then((u) => {
        setUser(u);
        navigate(takeNext(), { replace: true });
      })
      .catch(setError);
  }, [query.token, setUser]);
  return (
    <AuthShell title={error ? 'Verification failed' : 'Verifying…'}>
      {error ? (
        <>
          <p className="form-error">{error.message}</p>
          <p className="auth-alt"><a href="#/login">Sign in</a> · <a href="#/register">Register again</a></p>
        </>
      ) : <p className="muted">One moment.</p>}
    </AuthShell>
  );
}
