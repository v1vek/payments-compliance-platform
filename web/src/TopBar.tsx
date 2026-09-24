import type { User } from './api';

type Props = { user: User; area: string; badge: { text: string; onClick: () => void } | null; onSignOut: () => void };

export function TopBar({ user, area, badge, onSignOut }: Props) {
  return (
    <div style={{ position: 'sticky', top: 0, zIndex: 5, background: 'rgba(245,245,247,0.85)', backdropFilter: 'saturate(180%) blur(20px)', WebkitBackdropFilter: 'saturate(180%) blur(20px)', borderBottom: '1px solid #E5E5EA' }}>
      <div className="topbar-inner" style={{ maxWidth: 1240, margin: '0 auto', padding: '0 32px', height: 60, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
          <div style={{ width: 26, height: 26, borderRadius: 7, background: '#1D1D1F', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 600, fontSize: 13, flexShrink: 0 }}>M</div>
          <div style={{ fontSize: 16, fontWeight: 600, letterSpacing: '-0.01em' }}>Meridian</div>
          <div className="hide-sm" style={{ width: 1, height: 18, background: '#D2D2D7', margin: '0 6px' }} />
          <div className="hide-sm" style={{ fontSize: 14, color: '#6E6E73' }}>{area}</div>
          {badge && (
            <button className="badge-btn" onClick={badge.onClick}>
              <span style={{ width: 7, height: 7, borderRadius: '50%', background: '#0B63CE' }} />{badge.text}
            </button>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <div className="hide-sm" style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 1 }}>
            <div style={{ fontSize: 14, fontWeight: 500 }}>{user.name}</div>
            <div style={{ fontSize: 12, color: '#8E8E93' }}>{user.label}</div>
          </div>
          <div style={{ width: 34, height: 34, borderRadius: '50%', background: '#E5E5EA', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 600, color: '#48484A' }}>{user.initials}</div>
          <button className="btn btn-outline" onClick={onSignOut} style={{ height: 34, padding: '0 14px', borderRadius: 9, fontSize: 13 }}>Sign out</button>
        </div>
      </div>
    </div>
  );
}
