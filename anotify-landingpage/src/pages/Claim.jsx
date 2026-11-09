// agent 认领：登录用户把 CLI 显示的 8 位码填进 8 个格子，批准注册 / 绑定（DESIGN §14.4）
import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { navigate } from '../router.js';
import { useSession } from '../session.jsx';
import { track } from '../analytics.js';
import TopBar from '../components/TopBar.jsx';
import CodeInput from '../components/CodeInput.jsx';
import { useI18n } from '../i18n.js';

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
  const { t, rich, errMsg } = useI18n();
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
      track('claim_approved', { claim: id });
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
    body = <p className="muted">{t('common.loading')}</p>;
  } else if (error) {
    body = <p className="form-error">{errMsg(error)}</p>;
  } else if (done || (['approved', 'consumed'].includes(claim.status) && claim.approved_by_you)) {
    const collected = claim.status === 'consumed';
    body = (
      <div className="claim-done">
        <div className="big-check">✓</div>
        <p>
          <strong>{claim.display_name}</strong>{' '}
          {claim.kind === 'bind'
            ? t('claim.done.bound')
            : collected ? t('claim.done.registered') : t('claim.done.approved')}
        </p>
        <p className="muted">
          {claim.kind === 'bind' || collected
            ? t('claim.done.close')
            : rich('claim.done.resume')}
        </p>
        <a className="btn" href="#/console">{t('claim.done.console')}</a>
      </div>
    );
  } else if (claim.status !== 'pending') {
    const why = {
      expired: t('claim.why.expired'),
      locked: t('claim.why.locked'),
      approved: t('claim.why.taken'),
      consumed: t('claim.why.taken'),
    }[claim.status] ?? t('claim.why.other', { status: claim.status });
    body = (
      <>
        <p className="form-error">{why}</p>
        <p className="muted">{rich('claim.again')}</p>
      </>
    );
  } else {
    body = (
      <>
        <p className="claim-lead">
          {claim.kind === 'bind'
            ? rich('claim.lead.bind', { name: claim.display_name })
            : rich('claim.lead.register', { name: claim.display_name })}
        </p>
        {claim.same_name_agents > 0 && (
          <p className="notice">
            {rich('claim.same', { name: claim.display_name })}{' '}
            {claim.kind === 'bind' ? rich('claim.same.bind') : rich('claim.same.register')}
          </p>
        )}
        <p className="muted">{t('claim.enter', { email: user.email })}</p>
        <form onSubmit={(e) => { e.preventDefault(); submit(code); }}>
          <CodeInput value={code} onChange={setCode} disabled={busy || claim.same_name_agents > 0} onComplete={submit} />
          {submitError && <p className="form-error center">{errMsg(submitError)}</p>}
          <button className="btn btn-primary wide" disabled={busy || claim.same_name_agents > 0 || code.replace(/\s/g, '').length !== 8}>
            {busy ? t('claim.submit.busy') : claim.kind === 'bind' ? t('claim.submit.bind') : t('claim.submit.approve')}
          </button>
        </form>
        <p className="muted small center">{t('claim.expires.pre')} <Countdown until={claim.expires_at} /> {t('claim.expires.post')}</p>
      </>
    );
  }

  return (
    <div className="app-shell">
      <TopBar />
      <main className="app-main centered">
        <div className="panel auth-panel claim-panel">
          <h1 className="auth-title">{claim?.kind === 'bind' ? t('claim.bindTitle') : t('claim.approveTitle')}</h1>
          {body}
        </div>
      </main>
    </div>
  );
}
