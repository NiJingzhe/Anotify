// 危险操作确认：必须原样输入名称才能确认（删除 agent / 关闭频道）
import { useEffect, useRef, useState } from 'react';

export default function ConfirmDialog({ title, children, confirmText, actionLabel, onConfirm, onClose }) {
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const input = useRef(null);
  useEffect(() => {
    input.current?.focus();
    const onKey = (e) => { if (e.key === 'Escape' && !busy) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  const ok = typed === confirmText;
  return (
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <form
        className="modal panel"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onSubmit={async (e) => {
          e.preventDefault();
          if (!ok || busy) return;
          setBusy(true);
          setError(null);
          try {
            await onConfirm();
          } catch (err) {
            setError(err);
            setBusy(false);
          }
        }}
      >
        <h2 className="modal-title">{title}</h2>
        <div className="modal-body">{children}</div>
        <label className="modal-confirm">
          <span>Type <code>{confirmText}</code> to confirm</span>
          <input ref={input} value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false} />
        </label>
        {error && <p className="form-error">{error.message}</p>}
        <div className="modal-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="submit" className="btn btn-danger" disabled={!ok || busy}>{busy ? 'Working…' : actionLabel}</button>
        </div>
      </form>
    </div>
  );
}
