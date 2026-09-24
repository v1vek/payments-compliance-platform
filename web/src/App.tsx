import { useEffect, useState } from 'react';
import { api, type User } from './api';
import { Login } from './Login';
import { TopBar } from './TopBar';
import { CustomerScreen } from './Customer';
import { ComplianceScreen } from './Compliance';

export function App() {
  const [user, setUser] = useState<User | null | undefined>(undefined);
  const [demoMode, setDemoMode] = useState(false);
  const [badge, setBadge] = useState<{ text: string; onClick: () => void } | null>(null);

  useEffect(() => {
    api.me().then((r) => setUser(r.user), () => setUser(null));
    api.config().then((c) => setDemoMode(c.demoMode), () => {});
  }, []);

  if (user === undefined) return <div style={{ minHeight: '100vh' }} />;
  if (!user) return <Login demoMode={demoMode} onSignedIn={setUser} />;

  const signOut = async () => {
    await api.logout().catch(() => {});
    setBadge(null);
    setUser(null);
  };

  return (
    <div style={{ minHeight: '100vh', background: '#F5F5F7' }}>
      <TopBar user={user} area={user.role === 'compliance' ? 'Compliance' : 'Payments'} badge={badge} onSignOut={signOut} />
      {user.role === 'customer'
        ? <CustomerScreen demoMode={demoMode} onSessionExpired={() => setUser(null)} />
        : <ComplianceScreen me={user} setBadge={setBadge} onSessionExpired={() => setUser(null)} />}
    </div>
  );
}
