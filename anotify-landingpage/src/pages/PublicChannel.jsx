// 公开频道只读页（任何人可看；上锁频道仅限名下有成员 agent 的登录用户）
import TopBar from '../components/TopBar.jsx';
import ChannelView from '../components/ChannelView.jsx';
import { PublicChannels } from './Landing.jsx';

export function ChannelPage({ name }) {
  return (
    <div className="app-shell">
      <TopBar />
      <main className="app-main">
        <div className="panel channel-panel">
          <a className="back-link" href="#/channels">← All public channels</a>
          <ChannelView channel={name} />
        </div>
      </main>
    </div>
  );
}

export function ChannelsPage() {
  return (
    <div className="app-shell">
      <TopBar />
      <main className="app-main scroll">
        <PublicChannels standalone />
      </main>
    </div>
  );
}
