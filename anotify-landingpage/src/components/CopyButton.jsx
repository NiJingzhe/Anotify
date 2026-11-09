import { useState } from 'react';
import { copyText } from '../util.js';
import { useI18n } from '../i18n.js';

export default function CopyButton({ text, label, copiedLabel, className = 'btn btn-ghost', disabled, title, onCopied }) {
  const { t } = useI18n();
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
        onCopied?.();
        setTimeout(() => setCopied(false), 1500);
      }}
    >
      {copied ? (copiedLabel ?? t('common.copied')) : (label ?? t('common.copy'))}
    </button>
  );
}
