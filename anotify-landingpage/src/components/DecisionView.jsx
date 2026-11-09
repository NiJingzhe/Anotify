// 决策时间线（只读，DESIGN §15.5）：决策卡片、交接卡片、答复行。没有任何写入控件
import { useMemo } from 'react';
import { clockTime, dayLabel, nameHue } from '../util.js';
import { latestResolutions, parseDecision } from '../decisions.js';
import { useI18n, getLocale } from '../i18n.js';

const BECAUSE_TYPES = { user: 210, rule: 270, fact: 150, prior: 35, assumption: 0 };

function jumpTo(seq) {
  const el = document.getElementById(`dec-${seq}`);
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  return !!el;
}

/** 指向另一条记录的 #seq 标签：页面上有该卡片就滚过去，没有就只是文本 */
function SeqChip({ seq, present }) {
  if (!present) return <span className="seq-chip">#{seq}</span>;
  return (
    <a className="seq-chip is-link" href={`#dec-${seq}`} onClick={(e) => { e.preventDefault(); jumpTo(seq); }}>#{seq}</a>
  );
}

function Head({ m }) {
  const { t } = useI18n();
  const name = m.sender_name ?? m.sender;
  return (
    <header className="msg-head">
      <span className="sender" style={{ '--hue': nameHue(name) }}>{name}</span>
      {m.sender_owner && <span className="owner">{t('ch.belongs', { owner: m.sender_owner })}</span>}
      {m.sender_removed && <span className="owner">{t('ch.removed')}</span>}
      <span className="msg-time" title={new Date(m.created_at * 1000).toLocaleString(getLocale())}>{clockTime(m.created_at)}</span>
      <span className="msg-seq">#{m.seq}</span>
    </header>
  );
}

function Because({ items, present }) {
  const { t } = useI18n();
  if (!Array.isArray(items) || !items.length) return null;
  return (
    <ul className="because">
      {items.map((b, i) => {
        const known = b?.type in BECAUSE_TYPES;
        const hue = known ? BECAUSE_TYPES[b.type] : 220;
        return (
          <li key={i} className={`because-item${b?.type === 'assumption' ? ' is-assumption' : ''}`} style={{ '--chip-hue': hue }}>
            <span className="chip">{known ? t(`dec.type.${b.type}`) : String(b?.type ?? '?')}</span>
            {b?.type === 'prior' && b.ref != null && <SeqChip seq={b.ref} present={present.has(b.ref)} />}
            <span className="because-text">{String(b?.text ?? '')}</span>
          </li>
        );
      })}
    </ul>
  );
}

function DecisionCard({ m, d, present }) {
  const { t } = useI18n();
  return (
    <article className="dec-card kind-decision" id={`dec-${m.seq}`}>
      <Head m={m} />
      <h3 className="dec-title"><span className="dec-glyph" aria-hidden="true">◆</span>{String(d.decision ?? '')}</h3>
      <Because items={d.because} present={present} />
      {d.why_notify && <p className="dec-note"><strong>{t('dec.whyTold')}</strong> {String(d.why_notify)}</p>}
    </article>
  );
}

function HandoffCard({ m, d, present, resolution }) {
  const { t } = useI18n();
  const options = Array.isArray(d.options) ? d.options : [];
  const rd = resolution ? parseDecision(resolution) : null;
  const chosen = rd?.chosen ? options.find((o) => o.id === rd.chosen) : null;
  return (
    <article className={`dec-card kind-handoff${resolution ? ' is-resolved' : ' is-open'}`} id={`dec-${m.seq}`}>
      <Head m={m} />
      <div className="dec-status">
        {resolution
          ? <span className="status-badge is-resolved">{t('dec.resolved')}{rd?.chosen ? `: ${chosen?.label ?? rd.chosen}` : ''}{rd?.note ? ` — ${String(rd.note)}` : ''}</span>
          : <span className="status-badge is-waiting">{t('dec.waiting')}</span>}
      </div>
      <h3 className="dec-title"><span className="dec-glyph" aria-hidden="true">◇</span>{String(d.question ?? '')}</h3>
      {d.why_you && <p className="dec-note"><strong>{t('dec.whyYou')}</strong> {String(d.why_you)}</p>}
      {Array.isArray(d.done_so_far) && d.done_so_far.length > 0 && (
        <p className="dec-note"><strong>{t('dec.done')}</strong>{' '}
          {d.done_so_far.map((s) => <SeqChip key={s} seq={s} present={present.has(s)} />)}
        </p>
      )}
      {options.length > 0 && (
        <ol className="dec-options">
          {options.map((o, i) => (
            <li key={o?.id ?? i} className={`dec-option${o?.recommended ? ' is-recommended' : ''}${rd?.chosen && rd.chosen === o?.id ? ' is-chosen' : ''}`}>
              <span className="opt-id">{String(o?.id ?? '')}</span>
              <div className="opt-body">
                <div className="opt-label">
                  {String(o?.label ?? '')}
                  {o?.recommended && <span className="badge opt-badge">{t('dec.recommended')}</span>}
                  {rd?.chosen && rd.chosen === o?.id && <span className="badge opt-badge">{t('dec.chosen')}</span>}
                </div>
                {o?.outcome && <div className="opt-outcome">{String(o.outcome)}</div>}
              </div>
            </li>
          ))}
        </ol>
      )}
      {d.blocked && <p className="dec-note"><strong>{t('dec.ifUndecided')}</strong> {String(d.blocked)}</p>}
      {d.default_action && <p className="dec-note"><strong>{t('dec.defaultAction')}</strong> {String(d.default_action)}</p>}
    </article>
  );
}

function ResolutionRow({ m, d, present }) {
  const { t } = useI18n();
  return (
    <article className="dec-row kind-resolution" id={`dec-${m.seq}`}>
      <span className="dec-glyph" aria-hidden="true">✓</span>
      <span className="dec-row-text">
        <strong>{m.sender_name ?? m.sender}</strong> {t('dec.resolution.a')}
        {' '}{m.reply_to != null ? <SeqChip seq={m.reply_to} present={present.has(m.reply_to)} /> : t('dec.resolution.handoff')}
        {d.chosen ? <> — {t('dec.resolution.chose')} <strong>{String(d.chosen)}</strong></> : null}
        {d.decided_by ? <> · {t('dec.resolution.by', { who: String(d.decided_by) })}</> : null}
        {d.note ? <> — {String(d.note)}</> : null}
      </span>
      <span className="msg-time">{clockTime(m.created_at)}</span>
      <span className="msg-seq">#{m.seq}</span>
    </article>
  );
}

function Unparsed({ m }) {
  return (
    <article className="dec-card" id={`dec-${m.seq}`}>
      <Head m={m} />
      <pre className="msg-json">{String(m.content ?? '')}</pre>
    </article>
  );
}

/** @param {{ decisions: object[], hasOlder: boolean, loadingOlder: boolean, onLoadOlder: () => void, ready: boolean }} props */
export default function DecisionView({ decisions, hasOlder, loadingOlder, onLoadOlder, ready }) {
  const { t } = useI18n();
  const present = useMemo(() => new Set(decisions.map((m) => m.seq)), [decisions]);
  const resolutions = useMemo(() => latestResolutions(decisions), [decisions]);
  // 时间线：最新在前
  const ordered = useMemo(() => [...decisions].sort((a, b) => b.seq - a.seq), [decisions]);
  let lastDay = null;

  return (
    <div className="decisions">
      {ready && !decisions.length && (
        <div className="empty-state"><p>{t('dec.empty')}</p></div>
      )}
      {ordered.map((m) => {
        const day = dayLabel(m.created_at);
        const showDay = day !== lastDay;
        lastDay = day;
        const d = parseDecision(m);
        let body;
        if (!d) body = <Unparsed m={m} />;
        else if (d.kind === 'decision') body = <DecisionCard m={m} d={d} present={present} />;
        else if (d.kind === 'handoff') body = <HandoffCard m={m} d={d} present={present} resolution={resolutions.get(m.seq)} />;
        else if (d.kind === 'resolution') body = <ResolutionRow m={m} d={d} present={present} />;
        else body = <Unparsed m={m} />;
        return (
          <div key={m.seq}>
            {showDay && <div className="day-sep"><span>{day}</span></div>}
            {body}
          </div>
        );
      })}
      {hasOlder && (
        <div className="load-older">
          <button type="button" className="btn btn-ghost" onClick={onLoadOlder} disabled={loadingOlder}>
            {loadingOlder ? t('common.loading') : t('dec.loadOlder')}
          </button>
        </div>
      )}
    </div>
  );
}
