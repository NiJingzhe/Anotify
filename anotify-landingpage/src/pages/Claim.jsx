// agent 认领：登录用户把 CLI 显示的 8 位码填进 8 个格子，批准注册 / 绑定（DESIGN §14.4）
import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { navigate } from '../router.js';
import { useSession } from '../session.jsx';
import TopBar from '../components/TopBar.jsx';
import CodeInput from '../components/CodeInput.jsx';

function Countdown({ until }) {
  const [now, setNow] = useState(Date.now() / 1000);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now() / 1000), 1000);
    return () => clearInterval(t);
  }, []);
  const left = Math.max(0, Math.floor(until - now));
  return <span className={left < 60 ? 'warn' : ''}>{Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')}</span>;
}

export default function ClaimPage({ id }) {
  const { user } = useSession();
  const [claim, setClaim] = useState(null);
  const [error, setError] = useState(null);
  const [code, setCode] = useState('        ');
  const [busy, setBusy] = useState(false);
  const [submitError, setSubmitError] = useState(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (user === null) navigate(`/login?next=${encodeURIComponent(`/claim/${id}`)}`, { replace: true });
  }, [user, id]);

  useEffect(() => {
    if (!user) return;
    api('GET', `/v1/web/claims/${encodeURIComponent(id)}`).then(setClaim).catch(setError);
  }, [user, id]);

  const submit = async (value) => {
    const clean = value.replace(/\s/g, '');
    if (clean.length !== 8 || busy) return;
    setBusy(true);
    setSubmitError(null);
    try {
      await api('POST', `/v1/web/claims/${encodeURIComponent(id)}/approve`, { code: clean });
      setDone(true);
    } catch (e) {
      setSubmitError(e);
      if (e.code === 'wrong_code') setCode('        ');
      if (['claim_locked', 'claim_expired', 'claim_decided'].includes(e.code)) {
        api('GET', `/v1/web/claims/${encodeURIComponent(id)}`).then(setClaim).catch(() => {});
      }
    } finally {
      setBusy(false);
    }
  };

  let body;
  if (!user || (!claim && !error)) {
    body = <p className="muted">Loading…</p>;
  } else if (error) {
    body = <p className="form-error">{error.message}</p>;
  } else if (done || (claim.status !== 'pending' && claim.approved_by_you)) {
    body = (
      <div className="claim-done">
        <div className="big-check">✓</div>
        <p>
          <strong>{claim.display_name}</strong> {claim.kind === 'bind' ? 'is now bound to your account.' : 'is approved and now belongs to your account.'}
        </p>
        <p className="muted">Your agent picks this up automatically — you can close this page.</p>
        <a className="btn" href="#/console">Open console</a>
      </div>
    );
  } else if (claim.status !== 'pending') {
    const why = {
      expired: 'This request has expired (requests are valid for 10 minutes).',
      locked: 'Too many wrong codes were entered, so this request is void.',
      approved: 'This request was already approved by another account.',
      consumed: 'This request was already approved by another account.',
    }[claim.status] ?? `This request is ${claim.status}.`;
    body = (
      <>
        <p className="form-error">{why}</p>
        <p className="muted">Ask your agent to start again (<code>anotify register</code> / <code>anotify bind</code>) and open the new link.</p>
      </>
    );
  } else {
    body = (
      <>
        <p className="claim-lead">
          {claim.kind === 'bind'
            ? <>The existing agent <strong>{claim.display_name}</strong> wants to be bound to your account.</>
            : <>An agent wants to register as <strong>{claim.display_name}</strong> under your account.</>}
        </p>
        {claim.same_name_agents > 0 && (
          <p className="notice">
            You already own {claim.same_name_agents === 1 ? 'an agent' : `${claim.same_name_agents} agents`} named <strong>{claim.display_name}</strong>.
            Approving creates another, separate identity with the same name — if you meant to replace the old one, remove it from the console afterwards.
          </p>
        )}
        <p className="muted">Enter the 8-character code your agent showed you. Signed in as {user.email}.</p>
        <form onSubmit={(e) => { e.preventDefault(); submit(code); }}>
          <CodeInput value={code} onChange={setCode} disabled={busy} onComplete={submit} />
          {submitError && <p className="form-error center">{submitError.message}</p>}
          <button className="btn btn-primary wide" disabled={busy || code.replace(/\s/g, '').length !== 8}>
            {busy ? 'Approving…' : claim.kind === 'bind' ? 'Bind agent' : 'Approve agent'}
          </button>
        </form>
        <p className="muted small center">Expires in <Countdown until={claim.expires_at} /> · Only approve agents you started yourself.</p>
      </>
    );
  }

  return (
    <div className="app-shell">
      <TopBar />
      <main className="app-main centered">
        <div className="panel auth-panel claim-panel">
          <h1 className="auth-title">{claim?.kind === 'bind' ? 'Bind an agent' : 'Approve an agent'}</h1>
          {body}
        </div>
      </main>
    </div>
  );
}
