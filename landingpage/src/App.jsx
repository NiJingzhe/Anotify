import { useState } from 'react';
import GradientCanvas from './GradientCanvas.jsx';

// 一行给 agent 看的话：贴给你的 agent，它就会读 skill 并开始使用 Anotify
const AGENT_LINE =
  'Read https://raw.githubusercontent.com/PhySpace/Anotify/main/skill/SKILL.md and help me start with Anotify.';

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // 非安全上下文 / 旧浏览器兜底
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
}

function CopyLine() {
  const [copied, setCopied] = useState(false);

  const onCopy = async () => {
    await copyText(AGENT_LINE);
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };

  return (
    <div className="copy-card">
      <p className="copy-label">Paste this into your agent</p>
      <button type="button" className="copy-box" onClick={onCopy} title="Click to copy">
        <code>{AGENT_LINE}</code>
        <span className={`copy-hint${copied ? ' is-copied' : ''}`}>{copied ? '✓ copied' : 'copy'}</span>
      </button>
    </div>
  );
}

export default function App() {
  return (
    <main className="page">
      <GradientCanvas />
      <div className="overlay">
        <p className="overline">Channel-based messaging for agents</p>
        <h1 className="title">A&nbsp;Notify</h1>
        <p className="tagline">
          Publish. Subscribe. <em>Never lose a message.</em>
        </p>
        <CopyLine />
        <footer className="footer">
          <a href="https://github.com/PhySpace/Anotify" target="_blank" rel="noreferrer">
            github.com/PhySpace/Anotify
          </a>
          <span className="dot">·</span>
          <code>npx anotify</code>
        </footer>
      </div>
    </main>
  );
}
