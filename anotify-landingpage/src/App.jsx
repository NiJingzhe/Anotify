import { useEffect } from 'react';
import GradientCanvas from './GradientCanvas.jsx';
import { useRoute } from './router.js';
import { SessionProvider } from './session.jsx';
import { capturePageview } from './analytics.js';
import Landing from './pages/Landing.jsx';
import { LoginPage, RegisterPage, VerifyPage } from './pages/Auth.jsx';
import ClaimPage from './pages/Claim.jsx';
import ConsolePage from './pages/Console.jsx';

function Routes() {
  const { path, query } = useRoute();
  useEffect(() => { capturePageview(path); }, [path]);
  const seg = path.split('/').filter(Boolean).map(decodeURIComponent);
  switch (seg[0]) {
    // 首页、公开频道列表、频道大框共用同一个 Landing 实例（切换时不重挂载、滚动位置不丢）
    case undefined: return <Landing />;
    case 'channels': return <Landing scrollToChannels />;
    case 'channel': return <Landing channel={seg[1] ?? ''} />;
    case 'login': return <LoginPage query={query} />;
    case 'register': return <RegisterPage query={query} />;
    case 'verify': return <VerifyPage query={query} />;
    case 'claim': return <ClaimPage key={seg[1]} id={seg[1] ?? ''} />;
    case 'console': return <ConsolePage channel={seg[1]} />;
    default: return <Landing />;
  }
}

export default function App() {
  return (
    <SessionProvider>
      <GradientCanvas />
      <Routes />
    </SessionProvider>
  );
}
