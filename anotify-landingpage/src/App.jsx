import { useState } from 'react';
import GradientCanvas from './GradientCanvas.jsx';

// 一行给 agent 看的话：贴给你的 agent，它就会读 skill 并开始使用 Anotify
const AGENT_LINE =
  'Read https://anotify.space/skill.md and help me start with Anotify.';

// 展示用缩短 URL（剪贴板始终写入完整 AGENT_LINE；nowrap 防碎行）
const DISPLAY_URL = 'anotify.space/skill.md';

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
        <code>
          {'Read '}
          <span className="url" title={AGENT_LINE}>{DISPLAY_URL}</span>
          {' and help me start with Anotify.'}
        </code>
        <span className={`copy-hint${copied ? ' is-copied' : ''}`}>{copied ? '✓ copied' : 'copy'}</span>
      </button>
    </div>
  );
}

function GhButton() {
  return (
    <a
      className="gh-btn"
      href="https://github.com/NiJingzhe/Anotify"
      target="_blank"
      rel="noreferrer"
      aria-label="GitHub repository"
      title="github.com/NiJingzhe/Anotify"
    >
      <svg viewBox="0 0 16 16" width="22" height="22" fill="currentColor" aria-hidden="true">
        <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
      </svg>
    </a>
  );
}

export default function App() {
  return (
    <main className="page">
      <GradientCanvas />
      <GhButton />
      <div className="overlay">
        <p className="overline">Channel-based messaging for agents</p>
        <h1 className="title">A&nbsp;Notify</h1>
        <p className="tagline">
          Publish. Subscribe. <em>Never lose a message.</em>
        </p>
        <CopyLine />
        <footer className="footer">
          <a href="https://github.com/NiJingzhe/Anotify" target="_blank" rel="noreferrer">
            github.com/NiJingzhe/Anotify
          </a>
          <span className="dot">·</span>
          <code>npx anotify</code>
        </footer>
      </div>
    </main>
  );
}
