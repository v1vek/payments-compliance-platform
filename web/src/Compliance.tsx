import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError, type AuditEvent, type FlaggedPayment, type PaymentDetail, type Status, type User } from './api';
import { C, DAY, dotOf, fmt, fmtDate, fmtTime, type Tone } from './format';
import { ActivityLog } from './ActivityLog';

type Props = {
  me: User;
  setBadge: (b: { text: string; onClick: () => void } | null) => void;
  onSessionExpired: () => void;
};

const REASON_META: Record<FlaggedPayment['holdReason'], { short: string; title: string }> = {
  threshold: { short: '7-day threshold', title: '7-day cumulative total exceeds review threshold' },
  sanctions_timeout: { short: 'Screening timeout', title: 'Sanctions screening timed out' },
  sanctions_match: { short: 'Sanctions match', title: 'Sanctions list match' },
};

function officerStatus(p: { status: Status; recommendation?: unknown }): { label: string; tone: Tone } {
  if (p.status === 'on_hold') return p.recommendation ? { label: 'Needs final decision', tone: C.blue } : { label: 'Needs recommendation', tone: C.amber };
  if (p.status === 'sent') return { label: 'Released', tone: C.green };
  if (p.status === 'rejected') return { label: 'Rejected', tone: C.red };
  if (p.status === 'screening') return { label: 'Screening', tone: C.gray };
  return { label: 'Refused · sanctions', tone: C.red };
}

const lockIcon = (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#8E8E93" strokeWidth="2.2" strokeLinecap="round"><rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V8a4 4 0 018 0v3" /></svg>
);

export function ComplianceScreen({ me, setBadge, onSessionExpired }: Props) {
  const [view, setView] = useState<'queue' | 'log'>('queue');
  const [tab, setTab] = useState<'open' | 'closed'>('open');
  const [payments, setPayments] = useState<FlaggedPayment[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<PaymentDetail | null>(null);
  const [log, setLog] = useState<{ total: number; events: AuditEvent[] } | null>(null);
  const [note, setNote] = useState('');
  const [actionError, setActionError] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<'release' | 'reject' | null>(null);

  const handle = useCallback((err: unknown) => {
    if (err instanceof ApiError && err.status === 401) onSessionExpired();
  }, [onSessionExpired]);

  const loadList = useCallback(() => api.flagged().then((r) => setPayments(r.payments), handle), [handle]);
  const loadDetail = useCallback((id: string) => api.detail(id).then(setDetail, handle), [handle]);
  const loadLog = useCallback(() => api.audit().then(setLog, handle), [handle]);

  // Poll so new holds and the other officer's actions show up without a reload.
  const selectedRef = useRef(selectedId);
  selectedRef.current = selectedId;
  useEffect(() => {
    void loadList();
    const t = setInterval(() => {
      void loadList();
      if (selectedRef.current) void loadDetail(selectedRef.current);
    }, 5000);
    return () => clearInterval(t);
  }, [loadList, loadDetail]);

  useEffect(() => { if (view === 'log') void loadLog(); }, [view, loadLog]);

  const all = payments ?? [];
  const open = all.filter((p) => p.status === 'on_hold');
  const closed = all.filter((p) => p.status !== 'on_hold');
  const list = tab === 'open' ? open : closed;
  const mine = (p: FlaggedPayment) => p.status === 'on_hold' && (!p.recommendation || p.recommendation.byId !== me.id);
  const myItems = open.filter(mine);

  // Keep a valid selection within the current tab.
  const effectiveId = selectedId && list.some((p) => p.id === selectedId) ? selectedId : list[0]?.id ?? null;
  useEffect(() => {
    if (payments && effectiveId !== selectedId) setSelectedId(effectiveId);
  }, [payments, effectiveId, selectedId]);
  useEffect(() => {
    setDetail(null);
    if (selectedId) void loadDetail(selectedId);
  }, [selectedId, loadDetail]);

  const select = (id: string) => { setSelectedId(id); setNote(''); setActionError(''); };

  const firstMine = myItems[0]?.id;
  useEffect(() => {
    setBadge(myItems.length ? {
      text: `${myItems.length} ${myItems.length === 1 ? 'needs' : 'need'} your action`,
      onClick: () => { setView('queue'); setTab('open'); if (firstMine) select(firstMine); },
    } : null);
  }, [myItems.length, firstMine]);
  useEffect(() => () => setBadge(null), [setBadge]);

  const act = async (kind: 'rec' | 'dec', action: 'release' | 'reject') => {
    if (!selectedId || busy) return;
    setBusy(true);
    setActionError('');
    try {
      const d = kind === 'rec' ? await api.recommend(selectedId, action, note.trim()) : await api.decide(selectedId, action, note.trim());
      setDetail(d);
      setNote('');
      await loadList();
    } catch (err) {
      handle(err);
      setActionError(err instanceof Error ? err.message : 'Something went wrong.');
      void loadDetail(selectedId);
    } finally {
      setBusy(false);
    }
  };

  const tabStyle = (on: boolean) => ({ background: on ? '#fff' : 'transparent', boxShadow: on ? '0 1px 3px rgba(0,0,0,0.1)' : 'none' });
  const sp = detail && detail.payment.id === selectedId ? detail.payment : null;

  return (
    <div className="page" style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: 16, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <div style={{ fontSize: 28, fontWeight: 600, letterSpacing: '-0.02em' }}>{view === 'log' ? 'All activity' : 'Review queue'}</div>
          <div style={{ fontSize: 15, color: '#6E6E73' }}>
            {view === 'log' ? 'Every payment and compliance action across the system, newest first.' : 'Payments held for compliance review. Every decision needs two officers.'}
          </div>
        </div>
        <div style={{ display: 'flex', background: '#E9E9EE', borderRadius: 10, padding: 3, gap: 2 }}>
          {(['queue', 'log'] as const).map((v) => (
            <button key={v} className="btn" onClick={() => setView(v)} style={{ height: 32, padding: '0 14px', borderRadius: 8, fontSize: 13, color: '#1D1D1F', ...tabStyle(view === v) }}>
              {v === 'queue' ? 'Review queue' : 'All activity'}
            </button>
          ))}
        </div>
      </div>

      {view === 'log' && (
        <ActivityLog log={log} payments={all}
          onOpenPayment={(p) => { setView('queue'); setTab(p.status === 'on_hold' ? 'open' : 'closed'); select(p.id); }} />
      )}

      {view === 'queue' && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 24, alignItems: 'flex-start' }}>
          <div className="card" style={{ flex: '1 1 320px', maxWidth: list.length ? 380 : 'none', minWidth: 0, overflow: 'hidden' }}>
            <div style={{ padding: 12, borderBottom: '1px solid #F2F2F7', display: 'flex' }}>
              <div style={{ display: 'flex', flex: 1, maxWidth: list.length ? 'none' : 320, background: '#F2F2F7', borderRadius: 9, padding: 3, gap: 2 }}>
                {(['open', 'closed'] as const).map((t) => (
                  <button key={t} className="btn" onClick={() => { setTab(t); setSelectedId(null); setNote(''); }}
                    style={{ flex: 1, height: 30, borderRadius: 7, fontSize: 13, color: '#1D1D1F', ...tabStyle(tab === t) }}>
                    {t === 'open' ? `Open · ${open.length}` : `Closed · ${closed.length}`}
                  </button>
                ))}
              </div>
            </div>
            {payments && list.length === 0 && (
              <div style={{ padding: '72px 24px', textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
                {tab === 'open' && (
                  <div style={{ width: 44, height: 44, borderRadius: '50%', background: '#E6F4EA', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 4 }}>
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#1E7F45" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
                  </div>
                )}
                <div style={{ fontSize: 15, fontWeight: 600 }}>{tab === 'open' ? 'You’re all caught up' : 'No closed reviews yet'}</div>
                <div style={{ fontSize: 14, color: '#8E8E93', maxWidth: 320, textWrap: 'pretty' }}>
                  {tab === 'open' ? 'No payments are waiting for review. New holds will appear here.' : 'Released, rejected and refused payments will appear here.'}
                </div>
                <button className="btn btn-outline" onClick={() => setView('log')} style={{ marginTop: 12, height: 38, padding: '0 16px', borderRadius: 10, fontSize: 14 }}>View all activity</button>
              </div>
            )}
            {list.map((p, i) => {
              const on = p.id === selectedId;
              const waiting = p.status === 'on_hold' && !mine(p);
              const st = waiting ? { label: 'Awaiting other officer', tone: C.gray } : officerStatus(p);
              return (
                <button key={p.id} className="hover-row" onClick={() => select(p.id)}
                  style={{ width: '100%', textAlign: 'left', border: 'none', color: 'inherit', padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: 8, borderTop: i ? '1px solid #F2F2F7' : 'none', background: on ? '#F5F8FD' : '#fff', boxShadow: on ? 'inset 3px 0 0 #0B63CE' : 'none', opacity: waiting ? 0.6 : 1 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'baseline', width: '100%' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                      <span style={{ width: 7, height: 7, borderRadius: '50%', flexShrink: 0, background: mine(p) ? '#0B63CE' : 'transparent' }} />
                      <div className="ellipsis" style={{ fontSize: 15, fontWeight: 500 }}>{p.recipient}</div>
                    </div>
                    <div className="num" style={{ fontSize: 15, fontWeight: 600, whiteSpace: 'nowrap' }}>{fmt(p.amountCents)}</div>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center', width: '100%' }}>
                    <div className="ellipsis" style={{ fontSize: 13, color: '#8E8E93', minWidth: 0 }}>{p.code} · {REASON_META[p.holdReason].short}</div>
                    <div className="pill" style={{ padding: '3px 9px', background: st.tone[0], color: st.tone[1] }}>{st.label}</div>
                  </div>
                </button>
              );
            })}
          </div>

          {list.length > 0 && (
            <div style={{ flex: '1 1 560px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 20 }}>
              {!sp && <div className="card" style={{ padding: '64px 24px', textAlign: 'center', fontSize: 15, color: '#8E8E93' }}>{selectedId ? 'Loading…' : 'Select a payment to review'}</div>}
              {sp && detail && (
                <>
                  <FlagCard d={detail} />
                  {sp.holdReason !== 'sanctions_match' && (
                    <DecisionCard p={sp} me={me} note={note} setNote={setNote} busy={busy} error={actionError}
                      onRecommend={(a) => act('rec', a)} onDecide={(a) => setConfirm(a)} />
                  )}
                  <AuditCard events={detail.audit} />
                  <HistoryCard key={detail.payment.id} d={detail} />
                </>
              )}
            </div>
          )}
        </div>
      )}

      {confirm && sp && (
        <ConfirmModal p={sp} action={confirm} onCancel={() => setConfirm(null)} onConfirm={() => { const a = confirm; setConfirm(null); void act('dec', a); }} />
      )}
    </div>
  );
}

function FlagCard({ d }: { d: PaymentDetail }) {
  const sp = d.payment;
  const st = officerStatus(sp);
  const prior = sp.windowPriorCents ?? 0;
  const threshold = sp.thresholdCents ?? 0;
  const total = prior + sp.amountCents;
  const scale = Math.max(total, threshold) * 1.08 || 1;
  const pct = (c: number) => `${((c / scale) * 100).toFixed(2)}%`;
  const windowRows = [
    ...d.windowPayments.map((w) => ({ ...w, label: w.status === 'sent' ? 'Sent' : w.status === 'on_hold' ? 'On hold' : 'Processing' })),
    { id: sp.id, code: sp.code, recipient: sp.recipient, createdAt: sp.createdAt, amountCents: sp.amountCents, label: 'This payment' },
  ];

  return (
    <div className="card" style={{ padding: 28, display: 'flex', flexDirection: 'column', gap: 22 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
          <div style={{ fontSize: 13, color: '#8E8E93' }}>{sp.code} · Submitted {fmtTime(sp.createdAt)}</div>
          <div className="num" style={{ fontSize: 36, fontWeight: 600, letterSpacing: '-0.03em' }}>{fmt(sp.amountCents)}</div>
          <div style={{ fontSize: 15, color: '#48484A' }}>to <span style={{ fontWeight: 500, color: '#1D1D1F' }}>{sp.recipient}</span> · {sp.country}</div>
        </div>
        <div className="pill" style={{ fontSize: 13, padding: '6px 12px', background: st.tone[0], color: st.tone[1] }}>{st.label}</div>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 1, background: '#EDEDF0', borderRadius: 12, overflow: 'hidden' }}>
        {[['Customer', sp.customerName], ['Business', sp.businessName], ['Account', sp.account], ['Reference', sp.reference], ['Stored amount', `${sp.amountCents} cents`]].map(([k, v]) => (
          <div key={k} style={{ flex: '1 1 130px', background: '#F9F9FB', padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 }}>
            <div style={{ fontSize: 12, color: '#8E8E93' }}>{k}</div>
            <div className="num" style={{ fontSize: 14, fontWeight: 500, overflowWrap: 'anywhere' }}>{v}</div>
          </div>
        ))}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: '#6E6E73', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Why this was flagged</div>
        <div style={{ fontSize: 17, fontWeight: 600 }}>{REASON_META[sp.holdReason].title}</div>

        {sp.holdReason === 'threshold' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div style={{ fontSize: 14, color: '#48484A', textWrap: 'pretty' }}>
              This payment brings the customer's 7-day total to <b>{fmt(total)}</b>, over the <b>{fmt(threshold)}</b> review threshold. The payment on its own is below the threshold.
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ position: 'relative', height: 12, borderRadius: 6, background: '#F2F2F7', display: 'flex' }}>
                <div style={{ height: 12, borderRadius: '6px 0 0 6px', background: '#AEAEB2', width: pct(prior) }} />
                <div style={{ height: 12, background: '#E0A030', width: pct(sp.amountCents), borderRadius: '0 6px 6px 0' }} />
                <div style={{ position: 'absolute', top: -6, bottom: -6, width: 2, background: '#1D1D1F', left: pct(threshold) }} />
              </div>
              <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', fontSize: 12, color: '#6E6E73' }}>
                <Legend swatch={<div style={{ width: 10, height: 10, borderRadius: 3, background: '#AEAEB2' }} />}>Prior 7 days · {fmt(prior)}</Legend>
                <Legend swatch={<div style={{ width: 10, height: 10, borderRadius: 3, background: '#E0A030' }} />}>This payment · {fmt(sp.amountCents)}</Legend>
                <Legend swatch={<div style={{ width: 2, height: 12, background: '#1D1D1F' }} />}>Threshold · {fmt(threshold)}</Legend>
              </div>
            </div>
            <div style={{ border: '1px solid #EDEDF0', borderRadius: 12, overflow: 'hidden' }}>
              <div style={{ padding: '10px 14px', fontSize: 12, color: '#8E8E93', background: '#F9F9FB' }}>
                Payments in window ({fmtDate(new Date(sp.createdAt).getTime() - 7 * DAY)} – {fmtDate(sp.createdAt)})
              </div>
              {windowRows.map((w) => (
                <div key={w.id} style={{ display: 'grid', gridTemplateColumns: '90px minmax(0,1fr) auto auto', gap: 12, alignItems: 'center', padding: '10px 14px', borderTop: '1px solid #EDEDF0', fontSize: 13 }}>
                  <div style={{ color: '#8E8E93' }}>{w.code}</div>
                  <div className="ellipsis">{w.recipient} <span style={{ color: '#8E8E93' }}>· {fmtDate(w.createdAt)}</span></div>
                  <div style={{ color: '#6E6E73' }}>{w.label}</div>
                  <div className="num" style={{ fontWeight: 500, textAlign: 'right', minWidth: 90 }}>{fmt(w.amountCents)}</div>
                </div>
              ))}
              <div className="num" style={{ display: 'flex', justifyContent: 'space-between', padding: '10px 14px', borderTop: '1px solid #EDEDF0', fontSize: 13, fontWeight: 600 }}>
                <span>7-day total</span><span>{fmt(total)}</span>
              </div>
            </div>
          </div>
        )}

        {sp.holdReason === 'sanctions_timeout' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ fontSize: 14, color: '#48484A', textWrap: 'pretty' }}>
              The sanctions screening service did not respond in time. The system failed closed: the payment was held and no funds were sent. Screening is re-run on release and must pass before any money moves.
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', background: '#F9F9FB', borderRadius: 12, padding: '4px 14px' }}>
              <div className="kv" style={{ fontSize: 13, padding: '10px 0' }}><span>Screening result</span><span>Timeout · no result</span></div>
              <div className="kv" style={{ fontSize: 13, padding: '10px 0' }}><span>Screened name</span><span>{sp.recipient}</span></div>
              <div className="kv" style={{ fontSize: 13, padding: '10px 0' }}><span>Funds</span><span>{sp.status === 'on_hold' ? 'Reserved, not sent' : sp.status === 'sent' ? 'Sent after re-screening passed' : 'Returned, not sent'}</span></div>
            </div>
          </div>
        )}

        {sp.holdReason !== 'sanctions_match' && sp.status === 'refused' && sp.screening && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, border: '1px solid #F5DEDB', background: '#FDF3F2', borderRadius: 12, padding: '12px 14px' }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: '#B42318' }}>Refused at release: re-screening matched the sanctions list</div>
            <div style={{ fontSize: 13, color: '#48484A', textWrap: 'pretty' }}>
              “{sp.screening.input}” matched list entry “{sp.screening.entry}” ({sp.screening.type}) when screened again at release. No funds were sent; the reservation was returned.
            </div>
          </div>
        )}

        {sp.holdReason === 'sanctions_match' && sp.screening && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ fontSize: 14, color: '#48484A', textWrap: 'pretty' }}>
              The recipient name matched an entry on the sanctions list. The payment was refused automatically and no money moved. The customer was told only that it cannot be processed.
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', background: '#FDF3F2', borderRadius: 12, padding: '4px 14px' }}>
              <div className="kv" style={{ fontSize: 13, padding: '10px 0' }}><span>Entered name</span><span>{sp.screening.input}</span></div>
              <div className="kv" style={{ fontSize: 13, padding: '10px 0', borderColor: '#F5DEDB' }}><span>List entry</span><span>{sp.screening.entry}</span></div>
              <div className="kv" style={{ fontSize: 13, padding: '10px 0', borderColor: '#F5DEDB' }}><span>Match type</span><span>{sp.screening.type}</span></div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Legend({ swatch, children }: { swatch: React.ReactNode; children: React.ReactNode }) {
  return <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>{swatch}{children}</div>;
}

type DecisionProps = {
  p: FlaggedPayment; me: User; note: string; setNote: (s: string) => void; busy: boolean; error: string;
  onRecommend: (a: 'release' | 'reject') => void; onDecide: (a: 'release' | 'reject') => void;
};

function DecisionCard({ p, me, note, setNote, busy, error, onRecommend, onDecide }: DecisionProps) {
  const rec = p.recommendation, dec = p.decision;
  const onHold = p.status === 'on_hold';
  const step = (n: number, bg: string, fg: string) => (
    <div style={{ width: 28, height: 28, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 600, background: bg, color: fg }}>{n}</div>
  );
  return (
    <div className="card" style={{ padding: 28, display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div style={{ fontSize: 18, fontWeight: 600, letterSpacing: '-0.01em' }}>Decision</div>

      <div style={{ display: 'grid', gridTemplateColumns: '28px minmax(0,1fr)', gap: 14 }}>
        {rec ? step(1, '#1D1D1F', '#fff') : step(1, '#EAF2FD', '#0B63CE')}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, paddingTop: 4 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
            <div style={{ fontSize: 15, fontWeight: 600 }}>Recommendation</div>
            <div style={{ fontSize: 12, color: '#8E8E93' }}>First officer · advisory</div>
          </div>
          {rec && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 14, color: '#48484A' }}>
              <div><b>{rec.byName}</b> recommended <b>{rec.action === 'release' ? 'release' : 'rejection'}</b> · {fmtTime(rec.at)}</div>
              {rec.note && <div style={{ color: '#6E6E73', fontStyle: 'italic' }}>“{rec.note}”</div>}
            </div>
          )}
          {onHold && !rec && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <textarea className="textarea" value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000}
                placeholder="Add a note for the approving officer (optional)" rows={3} />
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                <button className="btn btn-primary" disabled={busy} onClick={() => onRecommend('release')} style={{ height: 42, padding: '0 18px', borderRadius: 10, fontSize: 14 }}>Recommend release</button>
                <button className="btn btn-outline-red" disabled={busy} onClick={() => onRecommend('reject')} style={{ height: 42, padding: '0 18px', borderRadius: 10, fontSize: 14 }}>Recommend rejection</button>
              </div>
            </div>
          )}
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '28px minmax(0,1fr)', gap: 14 }}>
        {dec ? step(2, '#1D1D1F', '#fff') : rec ? step(2, '#EAF2FD', '#0B63CE') : step(2, '#F2F2F7', '#AEAEB2')}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, paddingTop: 4 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
            <div style={{ fontSize: 15, fontWeight: 600 }}>Final decision</div>
            <div style={{ fontSize: 12, color: '#8E8E93' }}>Second officer · binding · re-screens before release</div>
          </div>
          {onHold && !rec && (
            <div style={{ fontSize: 14, color: '#8E8E93' }}>Available after a recommendation is made. The recommending officer cannot make the final decision.</div>
          )}
          {onHold && rec && rec.byId === me.id && (
            <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', background: '#F2F2F7', borderRadius: 10, padding: '12px 14px', fontSize: 14, color: '#48484A' }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#48484A" strokeWidth="2" strokeLinecap="round" style={{ flexShrink: 0, marginTop: 2 }}><rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V8a4 4 0 018 0v3" /></svg>
              <div>You made this recommendation, so a different compliance officer must make the final decision.</div>
            </div>
          )}
          {onHold && rec && rec.byId !== me.id && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <textarea className="textarea" value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} placeholder="Decision note (optional)" rows={2} />
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                <button className="btn btn-green" disabled={busy} onClick={() => onDecide('release')} style={{ height: 42, padding: '0 18px', borderRadius: 10, fontSize: 14 }}>Release payment</button>
                <button className="btn btn-red" disabled={busy} onClick={() => onDecide('reject')} style={{ height: 42, padding: '0 18px', borderRadius: 10, fontSize: 14 }}>Reject payment</button>
              </div>
            </div>
          )}
          {dec && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 14, color: '#48484A' }}>
              <div><b>{dec.byName}</b> decided to <b>{dec.action}</b> · {fmtTime(dec.at)}</div>
              {dec.note && <div style={{ color: '#6E6E73', fontStyle: 'italic' }}>“{dec.note}”</div>}
            </div>
          )}
        </div>
      </div>
      {busy && <div style={{ fontSize: 13, color: '#6E6E73' }}>Working…</div>}
      {error && <div role="alert" style={{ fontSize: 13, color: '#B42318' }}>{error}</div>}
    </div>
  );
}

const HISTORY_PREVIEW = 5;

function HistoryCard({ d }: { d: PaymentDetail }) {
  const sp = d.payment;
  const [showAll, setShowAll] = useState(false);
  // Newest first. The preview always includes the payment under review, even
  // when it is older than the most recent few.
  const preview = d.history.slice(0, HISTORY_PREVIEW);
  if (!preview.some((x) => x.id === sp.id)) {
    const self = d.history.find((x) => x.id === sp.id);
    if (self) preview.push(self);
  }
  const rows = showAll ? d.history : preview;
  const hidden = d.history.length - preview.length;
  return (
    <div className="card" style={{ padding: 28, display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12 }}>
        <div style={{ fontSize: 18, fontWeight: 600, letterSpacing: '-0.01em' }}>Customer history</div>
        <div style={{ fontSize: 12, color: '#8E8E93' }}>{sp.customerName} · {d.history.length} {d.history.length === 1 ? 'payment' : 'payments'}</div>
      </div>
      <div style={{ border: '1px solid #EDEDF0', borderRadius: 12, overflow: 'hidden' }}>
        {rows.map((x, i) => {
          const lab = x.holdReason ? officerStatus(x).label : x.status === 'sent' ? 'Sent' : 'Processing';
          const isThis = x.id === sp.id;
          const gap = !showAll && i > 0 && rows[i - 1] && d.history.indexOf(x) - d.history.indexOf(rows[i - 1]!) > 1;
          return (
            <div key={x.id}>
              {gap && <div style={{ padding: '4px 14px', fontSize: 12, color: '#AEAEB2', borderTop: '1px solid #EDEDF0', background: '#FAFAFC' }}>⋯</div>}
              <div style={{ display: 'grid', gridTemplateColumns: '84px minmax(0,1fr) auto auto', gap: 12, alignItems: 'center', padding: '11px 14px', fontSize: 13, borderTop: i ? '1px solid #EDEDF0' : 'none', background: isThis ? '#F5F8FD' : '#fff' }}>
                <div style={{ color: '#8E8E93' }}>{x.code}</div>
                <div className="ellipsis">{x.recipient} <span style={{ color: '#8E8E93' }}>· {fmtDate(x.createdAt)}</span></div>
                <div style={{ color: /Refused|Rejected/.test(lab) ? '#B42318' : '#6E6E73' }}>{isThis ? (x.status === 'on_hold' ? 'Under review' : 'This payment') : lab}</div>
                <div className="num" style={{ fontWeight: 500, textAlign: 'right', minWidth: 90 }}>{fmt(x.amountCents)}</div>
              </div>
            </div>
          );
        })}
      </div>
      {hidden > 0 && (
        <button className="btn-text" aria-expanded={showAll} onClick={() => setShowAll(!showAll)} style={{ alignSelf: 'flex-start' }}>
          {showAll ? 'Show fewer' : `Show all ${d.history.length} payments`}
        </button>
      )}
    </div>
  );
}

function AuditCard({ events }: { events: AuditEvent[] }) {
  return (
    <div className="card" style={{ padding: 28, display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
        <div style={{ fontSize: 18, fontWeight: 600, letterSpacing: '-0.01em' }}>Audit trail <span style={{ fontSize: 13, fontWeight: 400, color: '#8E8E93' }}>· this payment</span></div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#8E8E93' }}>
          {lockIcon}Append-only · {events.length} {events.length === 1 ? 'event' : 'events'}
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        {events.map((e, i) => (
          <div key={e.id} style={{ display: 'grid', gridTemplateColumns: '14px minmax(0,1fr) auto', gap: 14 }}>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
              <div style={{ width: 9, height: 9, borderRadius: '50%', marginTop: 5, background: dotOf(e.action) }} />
              <div style={{ flex: 1, width: 1, background: '#E5E5EA', marginTop: 4, opacity: i === events.length - 1 ? 0 : 1 }} />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2, paddingBottom: 16, minWidth: 0 }}>
              <div style={{ fontSize: 14, fontWeight: 500 }}>{e.action}</div>
              <div style={{ fontSize: 13, color: '#6E6E73', textWrap: 'pretty', overflowWrap: 'anywhere' }}>{e.detail}</div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 2, fontSize: 12, color: '#8E8E93', whiteSpace: 'nowrap' }}>
              <div>{e.actor}</div>
              <div>{fmtTime(e.at)}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function ConfirmModal({ p, action, onCancel, onConfirm }: { p: FlaggedPayment; action: 'release' | 'reject'; onCancel: () => void; onConfirm: () => void }) {
  const rel = action === 'release';
  const rec = p.recommendation;
  const against = rec && (rec.action === 'release') !== rel
    ? `This goes against ${rec.byName}’s recommendation to ${rec.action === 'release' ? 'release' : 'reject'}.` : '';
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);
  return (
    <div className="overlay" onClick={onCancel}>
      <div className="modal" role="alertdialog" aria-modal="true" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 420, gap: 14 }}>
        <div style={{ fontSize: 20, fontWeight: 600, letterSpacing: '-0.02em', textWrap: 'pretty' }}>{rel ? 'Release' : 'Reject'} {fmt(p.amountCents)} to {p.recipient}?</div>
        <div style={{ fontSize: 14, color: '#48484A', textWrap: 'pretty' }}>
          {rel
            ? 'The recipient is screened again against the current sanctions list. If it passes, the funds are sent immediately; if it matches, the payment is refused. This decision is final and will be recorded in the audit trail.'
            : 'The reserved funds will be returned to the customer, who will only see “cannot be processed”. This decision is final.'}
        </div>
        {against && <div style={{ fontSize: 13, color: '#9A5B00', background: '#FFF3DC', borderRadius: 10, padding: '10px 12px', textWrap: 'pretty' }}>{against}</div>}
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 8 }}>
          <button className="btn btn-outline" onClick={onCancel} style={{ height: 42, padding: '0 18px', borderRadius: 10, fontSize: 14 }}>Cancel</button>
          <button className={`btn ${rel ? 'btn-green' : 'btn-red'}`} autoFocus onClick={onConfirm} style={{ height: 42, padding: '0 18px', borderRadius: 10, fontSize: 14 }}>
            {rel ? 'Release payment' : 'Reject payment'}
          </button>
        </div>
      </div>
    </div>
  );
}
