import { useState } from 'react';
import { copyText } from '../util.js';

export default function CopyButton({ text, label = 'Copy', copiedLabel = '✓ Copied', className = 'btn btn-ghost', disabled, title }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className={className}
      disabled={disabled}
      title={title}
      onClick={async (e) => {
        e.stopPropagation();
        await copyText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
    >
      {copied ? copiedLabel : label}
    </button>
  );
}
