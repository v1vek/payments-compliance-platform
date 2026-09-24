import { useState } from 'react';
import type { AuditEvent, FlaggedPayment } from './api';
import { dotOf, fmtTime } from './format';

// Display-only grouping: the log stays one row per event in the database and
// the API. Here, consecutive events for the same payment fold into one
// expandable row, so time order is never rearranged.

type Filter = 'all' | 'payments' | 'reviews' | 'security';

const SECURITY = /^(Signed in|Signed out|Sign-in failed|Blocked:|Demo reset)/;
const REVIEWS = /^(Recommended|Final decision|Re-screening|Blocked: self-approval)/;

const FILTERS: { key: Filter; label: string; test: (e: AuditEvent) => boolean }[] = [
  { key: 'all', label: 'All', test: () => true },
  { key: 'payments', label: 'Payments', test: (e) => e.paymentId !== null },
  { key: 'reviews', label: 'Reviews', test: (e) => REVIEWS.test(e.action) },
  { key: 'security', label: 'Security', test: (e) => SECURITY.test(e.action) },
];

const SHORT: Record<string, string | null> = {
  'Payment submitted': 'Submitted',
  'Sanctions screening started': null,
  'Sanctions screening passed': 'Screening passed',
  'Sanctions screening timed out': 'Screening timed out',
  'Sanctions match': 'Sanctions match',
  'Review threshold reached': 'Threshold reached',
  'Payment placed on hold': 'On hold',
  'Payment refused': 'Refused',
  'Payment rejected': 'Rejected',
  'Payment sent': 'Sent',
  'Re-screening passed': 'Re-screen passed',
  'Re-screening timed out': 'Re-screen timed out',
  'Re-screening: sanctions match': 'Re-screen match',
};
const shortLabel = (a: string) => (a in SHORT ? SHORT[a] : a);

type Row = { kind: 'single'; e: AuditEvent } | { kind: 'group'; key: string; events: AuditEvent[] };

function groupConsecutive(events: AuditEvent[]): Row[] {
  const rows: Row[] = [];
  for (const e of events) {
    const last = rows[rows.length - 1];
    if (e.paymentId && last) {
      const lastPid = last.kind === 'single' ? last.e.paymentId : last.events[0]!.paymentId;
      if (lastPid === e.paymentId) {
        if (last.kind === 'single') rows[rows.length - 1] = { kind: 'group', key: `g${last.e.id}`, events: [last.e, e] };
        else last.events.push(e);
        continue;
      }
    }
    rows.push({ kind: 'single', e });
  }
  return rows;
}

type Props = {
  log: { total: number; events: AuditEvent[] } | null;
  payments: FlaggedPayment[];
  onOpenPayment: (p: FlaggedPayment) => void;
};

export function ActivityLog({ log, payments, onOpenPayment }: Props) {
  const [filter, setFilter] = useState<Filter>('all');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const events = log?.events ?? [];
  const active = FILTERS.find((f) => f.key === filter)!;
  const rows = groupConsecutive(events.filter(active.test));
  const toggle = (key: string) => setExpanded((s) => {
    const n = new Set(s);
    if (n.has(key)) n.delete(key); else n.add(key);
    return n;
  });

  const codeCell = (e: AuditEvent) => {
    const p = e.paymentId ? payments.find((x) => x.id === e.paymentId) : undefined;
    return p ? (
      <button className="btn-text" style={{ textAlign: 'left', alignSelf: 'start', paddingTop: 1 }} onClick={() => onOpenPayment(p)}>{e.paymentCode}</button>
    ) : (
      <div style={{ fontWeight: 500, paddingTop: 1, color: '#48484A' }}>{e.paymentCode ?? '—'}</div>
    );
  };

  const eventRow = (e: AuditEvent, nested = false) => (
    <div key={e.id} className="log-row" style={{ display: 'grid', gridTemplateColumns: '130px 84px minmax(0,1fr) 110px', gap: 16, alignItems: 'start', padding: nested ? '8px 24px' : '12px 24px', borderTop: nested ? 'none' : '1px solid #F2F2F7', background: nested ? '#FAFAFC' : undefined, fontSize: 13 }}>
      <div style={{ color: '#8E8E93', paddingTop: 1 }}>{fmtTime(e.at)}</div>
      {nested ? <div /> : codeCell(e)}
      <div style={{ display: 'flex', gap: 10, minWidth: 0, paddingLeft: nested ? 12 : 0, borderLeft: nested ? '2px solid #E5E5EA' : 'none' }}>
        <span style={{ width: 8, height: 8, borderRadius: '50%', flexShrink: 0, marginTop: 6, background: dotOf(e.action) }} />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
          <div style={{ fontSize: nested ? 13 : 14, fontWeight: 500 }}>{e.action}</div>
          <div style={{ color: '#6E6E73', textWrap: 'pretty', overflowWrap: 'anywhere' }}>{e.detail}</div>
        </div>
      </div>
      <div style={{ textAlign: 'right', color: '#48484A', paddingTop: 1 }}>{e.actor}</div>
    </div>
  );

  const groupRow = (key: string, evs: AuditEvent[]) => {
    const newest = evs[0]!;
    const chronological = [...evs].reverse();
    const chain = chronological.map((e) => shortLabel(e.action)).filter(Boolean).join(' → ');
    const actors = [...new Set(chronological.map((e) => e.actor))].join(', ');
    const open = expanded.has(key);
    return (
      <div key={key}>
        <div className="log-row" style={{ display: 'grid', gridTemplateColumns: '130px 84px minmax(0,1fr) 110px', gap: 16, alignItems: 'start', padding: '12px 24px', borderTop: '1px solid #F2F2F7', fontSize: 13 }}>
          <div style={{ color: '#8E8E93', paddingTop: 1 }}>{fmtTime(newest.at)}</div>
          {codeCell(newest)}
          <div style={{ display: 'flex', gap: 10, minWidth: 0 }}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', flexShrink: 0, marginTop: 6, background: dotOf(newest.action) }} />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
              <div style={{ fontSize: 14, fontWeight: 500 }}>{newest.action}</div>
              <div style={{ color: '#6E6E73', textWrap: 'pretty', overflowWrap: 'anywhere' }}>{chain}</div>
              <button className="btn-text" aria-expanded={open} onClick={() => toggle(key)} style={{ alignSelf: 'flex-start', fontSize: 12 }}>
                {open ? 'Hide' : 'Show'} {evs.length} events
              </button>
            </div>
          </div>
          <div style={{ textAlign: 'right', color: '#48484A', paddingTop: 1 }}>{actors}</div>
        </div>
        {open && <div style={{ paddingBottom: 6, background: '#FAFAFC' }}>{evs.map((e) => eventRow(e, true))}</div>}
      </div>
    );
  };

  return (
    <div className="card" style={{ overflow: 'hidden' }}>
      <div style={{ padding: '12px 24px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, background: '#F9F9FB', fontSize: 12, color: '#8E8E93', flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }} role="group" aria-label="Filter activity">
          {FILTERS.map((f) => {
            const on = f.key === filter;
            return (
              <button key={f.key} className="chip" aria-pressed={on} onClick={() => setFilter(f.key)}
                style={{ height: 28, background: on ? '#1D1D1F' : '#fff', color: on ? '#fff' : '#48484A', borderColor: on ? '#1D1D1F' : '#E5E5EA' }}>
                {f.label} · {events.filter(f.test).length}
              </button>
            );
          })}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#8E8E93" strokeWidth="2.2" strokeLinecap="round"><rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V8a4 4 0 018 0v3" /></svg>
          Append-only · {log ? `${log.total} events` : 'loading…'} · entries cannot be edited or deleted
        </div>
      </div>
      {log && rows.length === 0 && (
        <div style={{ padding: '48px 24px', textAlign: 'center', fontSize: 14, color: '#8E8E93' }}>No {active.label.toLowerCase()} events yet.</div>
      )}
      {rows.map((r) => (r.kind === 'single' ? eventRow(r.e) : groupRow(r.key, r.events)))}
    </div>
  );
}
