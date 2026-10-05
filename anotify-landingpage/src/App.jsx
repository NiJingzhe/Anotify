import GradientCanvas from './GradientCanvas.jsx';
import { useRoute } from './router.js';
import { SessionProvider } from './session.jsx';
import Landing from './pages/Landing.jsx';
import { ChannelPage, ChannelsPage } from './pages/PublicChannel.jsx';
import { LoginPage, RegisterPage, VerifyPage } from './pages/Auth.jsx';
import ClaimPage from './pages/Claim.jsx';
import ConsolePage from './pages/Console.jsx';

function Routes() {
  const { path, query } = useRoute();
  const seg = path.split('/').filter(Boolean).map(decodeURIComponent);
  switch (seg[0]) {
    case undefined: return <Landing />;
    case 'channels': return <ChannelsPage />;
    case 'channel': return <ChannelPage key={seg[1]} name={seg[1] ?? ''} />;
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
