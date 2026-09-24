import { useState } from 'react';
import { api, type User } from './api';

const TEST_ACCOUNTS = [
  { name: 'Alex Chen', email: 'alex@northwind.test', label: 'Customer', initials: 'AC' },
  { name: 'Priya Shah', email: 'priya.shah@meridian.test', label: 'Compliance user 1', initials: 'PS' },
  { name: 'Marcus Lee', email: 'marcus.lee@meridian.test', label: 'Compliance user 2', initials: 'ML' },
];
const DEMO_PASSWORD = 'demo1234';

export function Login({ demoMode, onSignedIn }: { demoMode: boolean; onSignedIn: (u: User) => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');

  const signIn = async (e = email, p = password) => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      onSignedIn((await api.login(e, p)).user);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign in failed.');
    } finally {
      setBusy(false);
    }
  };

  const reset = async () => {
    try {
      await api.resetDemo();
      setNotice('Demo reset: the customer has a fresh account. History is kept.');
    } catch {
      setNotice('Reset failed.');
    }
  };

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '48px 16px' }}>
      <div style={{ width: '100%', maxWidth: 420, display: 'flex', flexDirection: 'column', gap: 24 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, justifyContent: 'center' }}>
          <div style={{ width: 32, height: 32, borderRadius: 9, background: '#1D1D1F', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 600, fontSize: 16 }}>M</div>
          <div style={{ fontSize: 20, fontWeight: 600, letterSpacing: '-0.01em' }}>Meridian</div>
        </div>
        <form
          className="card"
          style={{ padding: 32, display: 'flex', flexDirection: 'column', gap: 20 }}
          onSubmit={(e) => { e.preventDefault(); void signIn(); }}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div style={{ fontSize: 24, fontWeight: 600, letterSpacing: '-0.02em' }}>Sign in</div>
            <div style={{ fontSize: 15, color: '#6E6E73' }}>Cross-border payments</div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <label className="field">Email
              <input className="input" type="email" autoComplete="username" value={email} placeholder="name@company.com"
                onChange={(e) => { setEmail(e.target.value); setError(''); }} />
            </label>
            <label className="field">Password
              <input className="input" type="password" autoComplete="current-password" value={password} placeholder="••••••••"
                onChange={(e) => { setPassword(e.target.value); setError(''); }} />
            </label>
            {error && <div role="alert" style={{ fontSize: 13, color: '#B42318' }}>{error}</div>}
          </div>
          <button type="submit" className="btn btn-primary" disabled={busy} style={{ height: 46, borderRadius: 11, fontSize: 15 }}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ fontSize: 12, fontWeight: 500, color: '#8E8E93', textTransform: 'uppercase', letterSpacing: '0.06em', padding: '0 4px' }}>
            Test accounts · password {DEMO_PASSWORD}
          </div>
          <div className="card" style={{ borderRadius: 16, overflow: 'hidden' }}>
            {TEST_ACCOUNTS.map((acc, i) => (
              <button key={acc.email} type="button" className="hover-row"
                onClick={() => { setEmail(acc.email); setPassword(DEMO_PASSWORD); void signIn(acc.email, DEMO_PASSWORD); }}
                style={{ width: '100%', textAlign: 'left', border: 'none', background: '#fff', display: 'flex', alignItems: 'center', gap: 12, padding: '14px 16px', borderTop: i ? '1px solid #F2F2F7' : 'none', color: 'inherit' }}>
                <div style={{ width: 36, height: 36, borderRadius: '50%', background: '#F2F2F7', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 600, color: '#48484A', flexShrink: 0 }}>{acc.initials}</div>
                <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <div style={{ fontSize: 15, fontWeight: 500 }}>{acc.name}</div>
                  <div className="ellipsis" style={{ fontSize: 13, color: '#6E6E73' }}>{acc.email}</div>
                </div>
                <div className="pill" style={{ color: '#48484A', background: '#F2F2F7' }}>{acc.label}</div>
              </button>
            ))}
          </div>
          {demoMode && (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, paddingTop: 4 }}>
              <button type="button" className="btn-muted" onClick={reset}>Reset demo data</button>
              {notice && <div style={{ fontSize: 12, color: '#6E6E73', textAlign: 'center' }}>{notice}</div>}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
