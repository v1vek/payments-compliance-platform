import type { Db } from '../db.js';
import type { SessionUser } from '../auth.js';
import { notFound } from '../errors.js';
import { paymentCode, type PaymentRow } from './payments.js';

// ---------------------------------------------------------------------------
// Customer view. Built field by field from an allow-list: hold reasons,
// screening results and review data never leave the server for a customer.
// ---------------------------------------------------------------------------

export type CustomerStatus = 'processing' | 'sent' | 'on_hold' | 'cannot_be_processed';

export type CustomerPayment = {
  id: string;
  code: string;
  recipient: string;
  country: string;
  account: string;
  reference: string;
  amountCents: number;
  status: CustomerStatus;
  submittedAt: string;
  heldAt: string | null;
  resolvedAt: string | null;
};

export function toCustomerPayment(p: PaymentRow): CustomerPayment {
  const status: CustomerStatus =
    p.status === 'screening' ? 'processing'
      : p.status === 'sent' ? 'sent'
        : p.status === 'on_hold' ? 'on_hold'
          : 'cannot_be_processed';
  return {
    id: p.id,
    code: paymentCode(p),
    recipient: p.recipient,
    country: p.country,
    account: p.account_details,
    reference: p.reference,
    amountCents: p.amount_cents,
    status,
    submittedAt: p.created_at.toISOString(),
    heldAt: p.held_at?.toISOString() ?? null,
    resolvedAt: p.resolved_at?.toISOString() ?? null,
  };
}

export async function customerOverview(db: Db, user: SessionUser) {
  const { rows: accts } = await db.query<{ id: string; holder_name: string; masked_number: string; ledger_cents: number; held_cents: number }>(
    `SELECT id, holder_name, masked_number, ledger_cents, held_cents FROM accounts WHERE owner_id = $1 AND status = 'active'`,
    [user.id],
  );
  const a = accts[0];
  if (!a) throw notFound('Account');
  const { rows } = await db.query<PaymentRow>(
    'SELECT * FROM payments WHERE account_id = $1 ORDER BY created_at DESC', [a.id]);
  return {
    account: {
      holderName: a.holder_name,
      maskedNumber: a.masked_number,
      currency: 'USD',
      ledgerCents: a.ledger_cents,
      heldCents: a.held_cents,
      availableCents: a.ledger_cents - a.held_cents,
    },
    payments: rows.map(toCustomerPayment),
  };
}

// ---------------------------------------------------------------------------
// Compliance view.
// ---------------------------------------------------------------------------

type ReviewJoin = {
  recommended_by: string | null; rec_name: string | null; recommendation: string | null;
  recommendation_note: string | null; recommended_at: Date | null;
  decided_by: string | null; dec_name: string | null; decision: string | null;
  decision_note: string | null; decided_at: Date | null;
};

type FlaggedRow = PaymentRow & ReviewJoin & { customer_name: string; business_name: string };

const FLAGGED_SELECT = `
  SELECT p.*, u.name AS customer_name, a.holder_name AS business_name,
         r.recommended_by, ru.name AS rec_name, r.recommendation, r.recommendation_note, r.recommended_at,
         r.decided_by, du.name AS dec_name, r.decision, r.decision_note, r.decided_at
    FROM payments p
    JOIN accounts a ON a.id = p.account_id
    JOIN users u ON u.id = p.created_by
    LEFT JOIN payment_reviews r ON r.payment_id = p.id
    LEFT JOIN users ru ON ru.id = r.recommended_by
    LEFT JOIN users du ON du.id = r.decided_by`;

function toFlagged(p: FlaggedRow) {
  return {
    id: p.id,
    code: paymentCode(p),
    recipient: p.recipient,
    country: p.country,
    account: p.account_details,
    reference: p.reference,
    amountCents: p.amount_cents,
    status: p.status,
    holdReason: p.hold_reason,
    createdAt: p.created_at.toISOString(),
    customerName: p.customer_name,
    businessName: p.business_name,
    screening: p.screening,
    thresholdCents: p.threshold_cents,
    windowPriorCents: p.window_prior_cents,
    recommendation: p.recommended_by ? {
      byId: p.recommended_by, byName: p.rec_name, action: p.recommendation,
      note: p.recommendation_note, at: p.recommended_at?.toISOString(),
    } : null,
    decision: p.decided_by ? {
      byId: p.decided_by, byName: p.dec_name, action: p.decision,
      note: p.decision_note, at: p.decided_at?.toISOString(),
    } : null,
  };
}

export async function flaggedPayments(db: Db) {
  const { rows } = await db.query<FlaggedRow>(
    `${FLAGGED_SELECT} WHERE p.hold_reason IS NOT NULL ORDER BY p.created_at DESC`);
  return rows.map(toFlagged);
}

const brief = (p: PaymentRow) => ({
  id: p.id, code: paymentCode(p), recipient: p.recipient, amountCents: p.amount_cents,
  status: p.status, holdReason: p.hold_reason, createdAt: p.created_at.toISOString(),
});

export async function paymentDetail(db: Db, id: string) {
  const { rows } = await db.query<FlaggedRow>(`${FLAGGED_SELECT} WHERE p.id = $1`, [id]);
  const p = rows[0];
  if (!p) throw notFound('Payment');
  const [windowRows, history, events] = await Promise.all([
    db.query<PaymentRow>('SELECT * FROM payments WHERE id = ANY($1) ORDER BY created_at', [p.window_payment_ids ?? []]),
    db.query<PaymentRow>('SELECT * FROM payments WHERE account_id = $1 ORDER BY created_at DESC', [p.account_id]),
    db.query('SELECT id, at, actor_name, action, detail FROM audit_events WHERE payment_id = $1 ORDER BY at DESC, id DESC', [id]),
  ]);
  return {
    payment: toFlagged(p),
    windowPayments: windowRows.rows.map(brief),
    history: history.rows.map(brief),
    audit: events.rows.map(auditDto),
  };
}

type AuditRow = { id: number; at: Date; actor_name: string; action: string; detail: string; payment_id?: string | null; number?: number | null };

const auditDto = (e: AuditRow) => ({
  id: e.id, at: e.at.toISOString(), actor: e.actor_name, action: e.action, detail: e.detail,
  paymentId: e.payment_id ?? null, paymentCode: e.number ? `PMT-${e.number}` : null,
});

export async function auditLog(db: Db, limit = 500) {
  const { rows } = await db.query<AuditRow>(
    `SELECT e.id, e.at, e.actor_name, e.action, e.detail, e.payment_id, p.number
       FROM audit_events e LEFT JOIN payments p ON p.id = e.payment_id
      ORDER BY e.at DESC, e.id DESC LIMIT $1`, [limit]);
  const { rows: count } = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM audit_events');
  return { total: count[0]!.n, events: rows.map(auditDto) };
}
