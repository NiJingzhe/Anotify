// 8 格验证码输入：自动跳格、退格回退、整段粘贴、去掉易混字符
// value 为定长字符串，空格表示空格子（保证格子位置不因中间留空而错位）
import { useRef } from 'react';

const ALLOWED = /[A-HJ-NP-Z2-9]/; // 与服务端 HUMAN_ALPHABET 一致（无 0/O/1/I/L）

export default function CodeInput({ length = 8, value, onChange, disabled, onComplete }) {
  const refs = useRef([]);
  const chars = Array.from({ length }, (_, i) => (value[i] && value[i] !== ' ' ? value[i] : ''));
  const encode = (arr) => arr.map((c) => c || ' ').join('');
  const complete = (arr) => arr.every(Boolean);

  const setAt = (i, ch) => {
    const next = chars.slice();
    next[i] = ch;
    onChange(encode(next));
    return next;
  };

  const fill = (start, text) => {
    const clean = [...text.toUpperCase()].filter((c) => ALLOWED.test(c));
    const next = chars.slice();
    let i = start;
    for (const c of clean) {
      if (i >= length) break;
      next[i++] = c;
    }
    onChange(encode(next));
    refs.current[Math.min(i, length - 1)]?.focus();
    if (complete(next)) onComplete?.(next.join(''));
  };

  return (
    <div className="code-input" role="group" aria-label={`${length}-character code`}>
      {chars.map((c, i) => (
        <input
          key={i}
          ref={(el) => { refs.current[i] = el; }}
          className={`code-cell${i === 3 ? ' gap-after' : ''}`}
          value={c}
          disabled={disabled}
          inputMode="text"
          autoCapitalize="characters"
          autoComplete="one-time-code"
          spellCheck={false}
          maxLength={length}
          aria-label={`Character ${i + 1}`}
          autoFocus={i === 0}
          onFocus={(e) => e.target.select()}
          onPaste={(e) => {
            e.preventDefault();
            fill(i, e.clipboardData.getData('text'));
          }}
          onChange={(e) => {
            const v = e.target.value;
            if (v.length > 1) {
              fill(i, v);
              return;
            }
            const ch = v.toUpperCase();
            if (ch && !ALLOWED.test(ch)) return;
            const next = setAt(i, ch);
            if (ch && i < length - 1) refs.current[i + 1]?.focus();
            if (ch && complete(next)) onComplete?.(next.join(''));
          }}
          onKeyDown={(e) => {
            if (e.key === 'Backspace' && !chars[i] && i > 0) {
              e.preventDefault();
              setAt(i - 1, '');
              refs.current[i - 1]?.focus();
            } else if (e.key === 'ArrowLeft' && i > 0) {
              refs.current[i - 1]?.focus();
            } else if (e.key === 'ArrowRight' && i < length - 1) {
              refs.current[i + 1]?.focus();
            }
          }}
        />
      ))}
    </div>
  );
}
