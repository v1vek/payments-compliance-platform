import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, type CustomerPayment, type CustomerStatus, type Overview } from './api';
import { C, fmt, fmtTime, initials, parseCents, type Tone } from './format';

const COUNTRIES = ['Germany', 'India', 'Mexico', 'Singapore', 'United Kingdom', 'Vietnam'];
const HOLD_COPY = 'Funds are reserved and haven’t left your account. Most reviews finish within 1 business day.';

type Form = { recipient: string; country: string; account: string; amount: string; reference: string };
const blankForm = (): Form => ({ recipient: '', country: 'Germany', account: '', amount: '', reference: '' });

const DEMOS: { label: string; form: Form }[] = [
  { label: '1 · Supplier $2,000', form: { recipient: 'Lindqvist Components GmbH', amount: '2000', country: 'Germany', account: 'DE89 3704 0044 0532 0130 00', reference: 'PO-4410' } },
  { label: '2 · Victor Orlanoff', form: { recipient: 'Victor Orlanoff', amount: '1500', country: 'United Kingdom', account: 'GB29 NWBK 6016 1331 9268 19', reference: 'Consulting' } },
  { label: '3 · $7,500 payment', form: { recipient: 'Saigon Textile Works', amount: '7500', country: 'Vietnam', account: 'VCB •••• 8830', reference: 'INV-7781' } },
  { label: '4 · Screening timeout', form: { recipient: 'Timeout Test Supplier', amount: '500', country: 'India', account: 'HDFC •••• 2291', reference: 'INV-0907' } },
];

const statusView = (s: CustomerStatus): { label: string; tone: Tone } =>
  s === 'sent' ? { label: 'Sent', tone: C.green }
    : s === 'on_hold' ? { label: 'On hold', tone: C.amber }
      : s === 'processing' ? { label: 'Processing', tone: C.blue }
        : { label: 'Cannot be processed', tone: C.gray };

type Step = 'form' | 'review' | 'processing' | 'result';

export function CustomerScreen({ demoMode, onSessionExpired }: { demoMode: boolean; onSessionExpired: () => void }) {
  const [data, setData] = useState<Overview | null>(null);
  const [form, setForm] = useState<Form>(blankForm);
  const [formError, setFormError] = useState('');
  const [step, setStep] = useState<Step>('form');
  const [idemKey, setIdemKey] = useState('');
  const [result, setResult] = useState<CustomerPayment | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await api.overview());
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) onSessionExpired();
    }
  }, [onSessionExpired]);

  useEffect(() => {
    void load();
    const t = setInterval(load, 5000); // pick up compliance decisions on held payments
    return () => clearInterval(t);
  }, [load]);

  if (!data) return <div className="page" />;
  const { account, payments } = data;

  const cents = parseCents(form.amount) ?? 0;
  const liveErr = cents > account.availableCents ? 'Amount exceeds your available balance.' : '';
  const formValid = !!form.recipient.trim() && cents > 0 && !liveErr;
  const setField = (k: keyof Form) => (e: { target: { value: string } }) => {
    setForm({ ...form, [k]: e.target.value });
    setFormError('');
  };

  const toReview = () => {
    if (!form.recipient.trim()) return setFormError('Enter a recipient name.');
    if (!cents) return setFormError('Enter a valid amount.');
    if (liveErr) return setFormError(liveErr);
    setIdemKey(crypto.randomUUID().replace(/-/g, '')); // one key per reviewed payment: double-clicks can't double-send
    setStep('review');
  };

  const confirmSend = async () => {
    setStep('processing');
    try {
      const { payment } = await api.sendPayment(form, idemKey);
      setResult(payment);
      setStep('result');
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return onSessionExpired();
      setFormError(err instanceof Error ? err.message : 'Something went wrong.');
      setStep('form');
    }
    void load();
  };

  const held = payments.filter((p) => p.status === 'on_hold');
  const detail = detailId ? payments.find((p) => p.id === detailId) : undefined;

  return (
    <div className="page" style={{ display: 'flex', flexWrap: 'wrap', gap: 24, alignItems: 'flex-start' }}>
      <div style={{ flex: '1 1 560px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 24 }}>
        {/* Balance */}
        <div className="card" style={{ padding: 28, display: 'flex', flexDirection: 'column', gap: 18 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <div style={{ fontSize: 14, color: '#6E6E73' }}>Available balance</div>
              <div className="num" style={{ fontSize: 44, fontWeight: 600, letterSpacing: '-0.03em' }}>{fmt(account.availableCents)}</div>
            </div>
            <div style={{ fontSize: 13, color: '#6E6E73', background: '#F2F2F7', borderRadius: 999, padding: '6px 12px' }}>{account.currency} · {account.maskedNumber}</div>
          </div>
          <div style={{ display: 'flex', gap: 32, flexWrap: 'wrap', paddingTop: 16, borderTop: '1px solid #F2F2F7' }}>
            <Stat label="Account balance"><span className="num">{fmt(account.ledgerCents)}</span></Stat>
            <Stat label="On hold">
              <span style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                <span className="num">{fmt(account.heldCents)}</span>
                {held.length > 0 && (
                  <button className="btn-text" onClick={() => setDetailId(held[0]!.id)}>{held.length > 1 ? 'View latest' : 'View'}</button>
                )}
              </span>
            </Stat>
            <Stat label="Account holder">{account.holderName}</Stat>
          </div>
        </div>

        {/* Activity */}
        <div className="card" style={{ overflow: 'hidden' }}>
          <div style={{ padding: '22px 24px 14px', display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
            <div style={{ fontSize: 18, fontWeight: 600, letterSpacing: '-0.01em' }}>Activity</div>
            <div style={{ fontSize: 13, color: '#8E8E93' }}>{payments.length} payments</div>
          </div>
          {payments.length === 0 && (
            <div style={{ padding: '32px 24px', borderTop: '1px solid #F2F2F7', fontSize: 14, color: '#8E8E93', textAlign: 'center' }}>No payments yet.</div>
          )}
          {payments.map((p) => {
            const st = statusView(p.status);
            const outflow = p.status === 'sent' || p.status === 'on_hold' || p.status === 'processing';
            return (
              <button key={p.id} className="hover-row activity-row" onClick={() => setDetailId(p.id)}
                style={{ width: '100%', textAlign: 'left', border: 'none', borderTop: '1px solid #F2F2F7', background: '#fff', color: 'inherit', display: 'grid', gridTemplateColumns: '40px minmax(0,1fr) auto auto', gap: 14, alignItems: 'center', padding: '14px 24px' }}>
                <div style={{ width: 40, height: 40, borderRadius: '50%', background: '#F2F2F7', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 600, color: '#48484A' }}>{initials(p.recipient)}</div>
                <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <div className="ellipsis" style={{ fontSize: 15, fontWeight: 500 }}>{p.recipient}</div>
                  <div className="ellipsis" style={{ fontSize: 13, color: '#8E8E93' }}>
                    {fmtTime(p.submittedAt)} · {p.country}{p.reference !== '—' ? ` · ${p.reference}` : ''}
                  </div>
                </div>
                <div className="pill" style={{ background: st.tone[0], color: st.tone[1] }}>{st.label}</div>
                <div className="num amt" style={{ fontSize: 15, fontWeight: 500, textAlign: 'right', minWidth: 100, color: outflow ? '#1D1D1F' : '#8E8E93' }}>
                  {outflow ? '−' : ''}{fmt(p.amountCents)}
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* Send panel */}
      <div className="card" style={{ flex: '1 1 380px', maxWidth: 460, minWidth: 0, padding: 28, display: 'flex', flexDirection: 'column', gap: 20, position: 'sticky', top: 84 }}>
        {step === 'form' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <div style={{ fontSize: 20, fontWeight: 600, letterSpacing: '-0.02em' }}>Send a payment</div>
              <div style={{ fontSize: 14, color: '#6E6E73' }}>International transfer in USD</div>
            </div>
            {demoMode && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div style={{ fontSize: 12, color: '#8E8E93' }}>Demo scenarios</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {DEMOS.map((d) => (
                    <button key={d.label} className="chip" onClick={() => { setForm(d.form); setFormError(''); }}>{d.label}</button>
                  ))}
                </div>
              </div>
            )}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <label className="field">Recipient name
                <input className="input" value={form.recipient} onChange={setField('recipient')} placeholder="Business or individual" maxLength={140} />
              </label>
              <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)', gap: 12 }}>
                <label className="field">Country
                  <select className="input" value={form.country} onChange={setField('country')} style={{ padding: '0 12px' }}>
                    {COUNTRIES.map((c) => <option key={c}>{c}</option>)}
                  </select>
                </label>
                <label className="field">Account / IBAN
                  <input className="input" value={form.account} onChange={setField('account')} placeholder="DE89 3704 …" maxLength={64} />
                </label>
              </div>
              <label className="field">Amount
                <div style={{ position: 'relative', display: 'flex' }}>
                  <div style={{ position: 'absolute', left: 14, top: 0, bottom: 0, display: 'flex', alignItems: 'center', fontSize: 22, color: '#8E8E93' }}>$</div>
                  <input className="input num" value={form.amount} onChange={setField('amount')} inputMode="decimal" placeholder="0.00"
                    style={{ flex: 1, height: 56, padding: '0 60px 0 32px', fontSize: 24, fontWeight: 500 }} />
                  <div style={{ position: 'absolute', right: 14, top: 0, bottom: 0, display: 'flex', alignItems: 'center', fontSize: 14, color: '#8E8E93' }}>USD</div>
                </div>
              </label>
              <label className="field">
                <span>Reference <span style={{ fontWeight: 400, color: '#8E8E93' }}>Optional</span></span>
                <input className="input" value={form.reference} onChange={setField('reference')} placeholder="Invoice number" maxLength={64} />
              </label>
              {(formError || liveErr) && <div role="alert" style={{ fontSize: 13, color: '#B42318' }}>{formError || liveErr}</div>}
            </div>
            <button className="btn btn-primary" onClick={toReview} disabled={!formValid} style={{ height: 48, borderRadius: 12, fontSize: 15 }}>Continue</button>
          </div>
        )}

        {step === 'review' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <div style={{ fontSize: 20, fontWeight: 600, letterSpacing: '-0.02em' }}>Review payment</div>
              <div style={{ fontSize: 14, color: '#6E6E73' }}>Check the details before sending</div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, padding: '12px 0', textAlign: 'center' }}>
              <div className="num" style={{ fontSize: 40, fontWeight: 600, letterSpacing: '-0.03em' }}>{fmt(cents)}</div>
              <div style={{ fontSize: 15, color: '#6E6E73' }}>to {form.recipient}</div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', background: '#F9F9FB', borderRadius: 12, padding: '4px 16px' }}>
              <div className="kv"><span>Country</span><span>{form.country}</span></div>
              <div className="kv"><span>Account</span><span>{form.account || '—'}</span></div>
              <div className="kv"><span>Reference</span><span>{form.reference || '—'}</span></div>
              <div className="kv"><span>Fee</span><span>$0.00</span></div>
              <div className="kv"><span>Balance after</span><span className="num">{fmt(account.availableCents - cents)}</span></div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <button className="btn btn-primary" onClick={confirmSend} style={{ height: 48, borderRadius: 12, fontSize: 15 }}>Send {fmt(cents)}</button>
              <button className="btn btn-ghost" onClick={() => setStep('form')} style={{ height: 44, borderRadius: 12, fontSize: 15 }}>Edit details</button>
            </div>
          </div>
        )}

        {step === 'processing' && (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16, padding: '64px 0' }} aria-live="polite">
            <div style={{ width: 36, height: 36, borderRadius: '50%', border: '3px solid #E5E5EA', borderTopColor: '#0B63CE', animation: 'mspin 0.8s linear infinite' }} />
            <div style={{ fontSize: 16, fontWeight: 500 }}>Processing payment</div>
            <div style={{ fontSize: 14, color: '#8E8E93' }}>This only takes a moment</div>
          </div>
        )}

        {step === 'result' && result && <Result p={result} onDone={() => { setStep('form'); setForm(blankForm()); setResult(null); }} />}
      </div>

      {detail && <PaymentModal p={detail} onClose={() => setDetailId(null)} />}
    </div>
  );
}

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <div style={{ fontSize: 13, color: '#8E8E93' }}>{label}</div>
      <div style={{ fontSize: 16, fontWeight: 500 }}>{children}</div>
    </div>
  );
}

function Result({ p, onDone }: { p: CustomerPayment; onDone: () => void }) {
  const kind = p.status === 'sent' ? 'sent' : p.status === 'on_hold' || p.status === 'processing' ? 'hold' : 'refused';
  const title = { sent: 'Payment sent', hold: 'Payment on hold', refused: 'Cannot be processed' }[kind];
  const body = {
    sent: `${fmt(p.amountCents)} is on its way to ${p.recipient}.`,
    hold: `This payment is on hold. ${HOLD_COPY}`,
    refused: 'This payment cannot be processed. No money has left your account.',
  }[kind];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', gap: 14, padding: '28px 0 8px' }} aria-live="polite">
      {kind === 'sent' && (
        <div style={{ width: 64, height: 64, borderRadius: '50%', background: '#E6F4EA', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#1E7F45" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
        </div>
      )}
      {kind === 'hold' && (
        <div style={{ width: 64, height: 64, borderRadius: '50%', background: '#FFF3DC', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#9A5B00" strokeWidth="2.2" strokeLinecap="round"><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></svg>
        </div>
      )}
      {kind === 'refused' && (
        <div style={{ width: 64, height: 64, borderRadius: '50%', background: '#F2F2F7', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#48484A" strokeWidth="2.4" strokeLinecap="round"><path d="M7 7l10 10M17 7L7 17" /></svg>
        </div>
      )}
      <div style={{ fontSize: 22, fontWeight: 600, letterSpacing: '-0.02em' }}>{title}</div>
      <div style={{ fontSize: 15, color: '#6E6E73', maxWidth: 300, textWrap: 'pretty' }}>{body}</div>
      <div style={{ display: 'flex', flexDirection: 'column', background: '#F9F9FB', borderRadius: 12, padding: '4px 16px', width: '100%', marginTop: 8, textAlign: 'left' }}>
        <div className="kv"><span>Amount</span><span className="num">{fmt(p.amountCents)}</span></div>
        <div className="kv"><span>Recipient</span><span>{p.recipient}</span></div>
        <div className="kv"><span>Status</span><span>{statusView(p.status).label}</span></div>
        <div className="kv"><span>Payment ID</span><span>{p.code}</span></div>
      </div>
      <button className="btn btn-dark" onClick={onDone} style={{ height: 48, width: '100%', borderRadius: 12, fontSize: 15, marginTop: 8 }}>Done</button>
    </div>
  );
}

function PaymentModal({ p, onClose }: { p: CustomerPayment; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const st = statusView(p.status);
  const timeline: { label: string; time: string; dot: string }[] = [{ label: 'Submitted', time: fmtTime(p.submittedAt), dot: '#AEAEB2' }];
  if (p.heldAt) timeline.push({ label: 'On hold', time: fmtTime(p.heldAt), dot: '#E0A030' });
  if (p.status === 'sent') timeline.push({ label: 'Sent', time: fmtTime(p.resolvedAt ?? p.submittedAt), dot: '#1E7F45' });
  if (p.status === 'cannot_be_processed') timeline.push({ label: 'Cannot be processed', time: fmtTime(p.resolvedAt ?? p.submittedAt), dot: '#8E8E93' });

  const note = p.status === 'sent' ? 'Debited from your account balance.'
    : p.status === 'on_hold' ? HOLD_COPY
      : p.status === 'processing' ? 'This payment is being processed.'
        : p.heldAt ? 'This payment cannot be processed. The reserved funds are back in your available balance.'
          : 'This payment cannot be processed. No money has left your account.';

  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={`Payment ${p.code}`} onClick={(e) => e.stopPropagation()} style={{ maxWidth: 440, gap: 20 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ fontSize: 13, color: '#8E8E93' }}>{p.code}</div>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#48484A" strokeWidth="3" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
          </button>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, textAlign: 'center' }}>
          <div className="num" style={{ fontSize: 36, fontWeight: 600, letterSpacing: '-0.03em' }}>{fmt(p.amountCents)}</div>
          <div style={{ fontSize: 15, color: '#6E6E73' }}>to {p.recipient}</div>
          <div className="pill" style={{ fontSize: 13, padding: '5px 12px', background: st.tone[0], color: st.tone[1] }}>{st.label}</div>
          <div style={{ fontSize: 14, color: '#6E6E73', maxWidth: 320, textWrap: 'pretty' }}>{note}</div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', padding: '0 4px' }}>
          {timeline.map((t, i) => (
            <div key={t.label} style={{ display: 'grid', gridTemplateColumns: '14px minmax(0,1fr) auto', gap: 12 }}>
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                <div style={{ width: 10, height: 10, borderRadius: '50%', marginTop: 4, background: t.dot }} />
                <div style={{ flex: 1, width: 2, background: '#E5E5EA', marginTop: 3, opacity: i === timeline.length - 1 ? 0 : 1 }} />
              </div>
              <div style={{ fontSize: 14, fontWeight: 500, paddingBottom: 18 }}>{t.label}</div>
              <div style={{ fontSize: 13, color: '#8E8E93' }}>{t.time}</div>
            </div>
          ))}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', background: '#F9F9FB', borderRadius: 12, padding: '4px 16px' }}>
          <div className="kv"><span>Country</span><span>{p.country}</span></div>
          <div className="kv"><span>Account</span><span>{p.account}</span></div>
          <div className="kv"><span>Reference</span><span>{p.reference}</span></div>
        </div>
      </div>
    </div>
  );
}
