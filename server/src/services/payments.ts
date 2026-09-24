import { tx, type Db, type Tx } from '../db.js';
import { audit, SYSTEM, type Actor } from '../audit.js';
import { AppError, conflict, notFound } from '../errors.js';
import { formatUsd } from '../money.js';
import { screenWithTimeout, type SanctionsScreener, type ScreeningOutcome } from '../sanctions.js';
import type { SessionUser } from '../auth.js';

export type Deps = {
  db: Db;
  screener: SanctionsScreener;
  sanctionsTimeoutMs: number;
  thresholdCents: number;
  windowDays: number;
};

export type PaymentRow = {
  id: string;
  number: number;
  account_id: string;
  created_by: string;
  idempotency_key: string | null;
  recipient: string;
  country: string;
  account_details: string;
  reference: string;
  amount_cents: number;
  status: 'screening' | 'sent' | 'on_hold' | 'refused' | 'rejected';
  hold_reason: 'threshold' | 'sanctions_timeout' | 'sanctions_match' | null;
  screening: { entry: string; type: string; score: number; input: string } | null;
  threshold_cents: number | null;
  window_prior_cents: number | null;
  window_payment_ids: string[] | null;
  created_at: Date;
  held_at: Date | null;
  resolved_at: Date | null;
};

export type NewPayment = {
  recipient: string;
  country: string;
  accountDetails: string;
  reference: string;
  amountCents: number;
};

export const paymentCode = (p: { number: number }) => `PMT-${p.number}`;

const LIVE_STATUSES = ['sent', 'on_hold', 'screening'];

async function lockAccount(c: Tx, accountId: string) {
  const { rows } = await c.query<{ id: string; ledger_cents: number; held_cents: number }>(
    'SELECT id, ledger_cents, held_cents FROM accounts WHERE id = $1 FOR UPDATE',
    [accountId],
  );
  if (!rows[0]) throw notFound('Account');
  return rows[0];
}

async function lockPayment(c: Tx, id: string): Promise<PaymentRow> {
  const { rows } = await c.query<PaymentRow>('SELECT * FROM payments WHERE id = $1 FOR UPDATE', [id]);
  if (!rows[0]) throw notFound('Payment');
  return rows[0];
}

/** Debit a reserved amount: the money leaves the account. */
export async function settleReserved(c: Tx, accountId: string, cents: number) {
  await c.query(
    'UPDATE accounts SET ledger_cents = ledger_cents - $2, held_cents = held_cents - $2 WHERE id = $1',
    [accountId, cents],
  );
}

/** Release a reservation: no money moves. */
export async function releaseReserved(c: Tx, accountId: string, cents: number) {
  await c.query('UPDATE accounts SET held_cents = held_cents - $2 WHERE id = $1', [accountId, cents]);
}

/**
 * Submit a payment. Three steps, so a screening outage can never leave money sent:
 *   1. (tx) reserve funds, insert payment as `screening`, audit.
 *   2. call the sanctions screener with a hard timeout, outside any transaction.
 *   3. (tx) apply the outcome: refuse, hold, or check the 7-day threshold and send.
 * If the process dies between 1 and 3 the payment stays `screening` with funds
 * reserved; the sweeper later moves it to on_hold. Nothing is ever sent without
 * a clear screening result.
 */
export async function submitPayment(
  deps: Deps,
  user: SessionUser,
  input: NewPayment,
  idempotencyKey: string | null,
): Promise<PaymentRow> {
  const actor: Actor = { id: user.id, name: user.name };

  type Step1 = { replay: PaymentRow } | { created: PaymentRow };
  const step1 = await tx(deps.db, async (c): Promise<Step1> => {
    if (idempotencyKey) {
      const existing = await c.query<PaymentRow>(
        'SELECT * FROM payments WHERE created_by = $1 AND idempotency_key = $2',
        [user.id, idempotencyKey],
      );
      if (existing.rows[0]) return { replay: checkReplay(existing.rows[0], input) };
    }
    const { rows: accts } = await c.query<{ id: string }>(
      `SELECT id FROM accounts WHERE owner_id = $1 AND status = 'active' FOR UPDATE`,
      [user.id],
    );
    const account = accts[0];
    if (!account) throw notFound('Account');
    const reserved = await c.query(
      `UPDATE accounts SET held_cents = held_cents + $2
        WHERE id = $1 AND ledger_cents - held_cents >= $2`,
      [account.id, input.amountCents],
    );
    if (reserved.rowCount !== 1) {
      throw new AppError(422, 'insufficient_funds', 'Amount exceeds your available balance.');
    }
    const { rows } = await c.query<PaymentRow>(
      `INSERT INTO payments (account_id, created_by, idempotency_key, recipient, country,
                             account_details, reference, amount_cents, status, threshold_cents)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'screening', $9)
       RETURNING *`,
      [account.id, user.id, idempotencyKey, input.recipient, input.country, input.accountDetails,
        input.reference, input.amountCents, deps.thresholdCents],
    );
    const p = rows[0]!;
    await audit(c, actor, 'Payment submitted', `${formatUsd(p.amount_cents)} to ${p.recipient}`, p.id);
    await audit(c, SYSTEM, 'Sanctions screening started', `Screening “${p.recipient}” against sanctions list`, p.id);
    return { created: p };
  }).catch(async (err: unknown): Promise<Step1> => {
    // Two concurrent requests with the same key: the loser replays the winner.
    if (idempotencyKey && (err as { code?: string }).code === '23505') {
      const { rows } = await deps.db.query<PaymentRow>(
        'SELECT * FROM payments WHERE created_by = $1 AND idempotency_key = $2',
        [user.id, idempotencyKey],
      );
      const winner = rows[0];
      if (winner) return { replay: checkReplay(winner, input) };
    }
    throw err;
  });

  if ('replay' in step1) return step1.replay;
  const payment = step1.created;

  const outcome = await screenWithTimeout(deps.screener, payment.recipient, deps.sanctionsTimeoutMs, 'initial');

  return applyScreeningOutcome(deps, payment.id, outcome);
}

function checkReplay(existing: PaymentRow, input: NewPayment): PaymentRow {
  if (existing.amount_cents !== input.amountCents || existing.recipient !== input.recipient) {
    throw conflict('idempotency_key_reused', 'This request was already used for a different payment.');
  }
  return existing;
}

export async function applyScreeningOutcome(deps: Deps, paymentId: string, outcome: ScreeningOutcome): Promise<PaymentRow> {
  return tx(deps.db, async (c) => {
    const { rows: ids } = await c.query<{ account_id: string }>('SELECT account_id FROM payments WHERE id = $1', [paymentId]);
    if (!ids[0]) throw notFound('Payment');
    await lockAccount(c, ids[0].account_id); // lock order everywhere: account, then payment
    const p = await lockPayment(c, paymentId);
    if (p.status !== 'screening') return p; // the sweeper already held it

    if (outcome.kind === 'unavailable') {
      await audit(c, SYSTEM, 'Sanctions screening timed out',
        `${outcome.reason === 'timeout' ? 'No response from screening service' : 'Screening service error'} · failed closed, no result recorded`,
        p.id, { reason: outcome.reason, message: outcome.message });
      return hold(c, p, 'sanctions_timeout');
    }

    if (outcome.kind === 'match') {
      await releaseReserved(c, p.account_id, p.amount_cents);
      const { rows } = await c.query<PaymentRow>(
        `UPDATE payments SET status = 'refused', hold_reason = 'sanctions_match', screening = $2, resolved_at = now()
          WHERE id = $1 RETURNING *`,
        [p.id, { ...outcome.match, input: p.recipient }],
      );
      await audit(c, SYSTEM, 'Sanctions match', `“${p.recipient}” matched list entry “${outcome.match.entry}”`, p.id, outcome.match);
      await audit(c, SYSTEM, 'Payment refused', 'No funds moved · customer shown “cannot be processed”', p.id);
      return rows[0]!;
    }

    await audit(c, SYSTEM, 'Sanctions screening passed', 'No match against sanctions list', p.id);

    const since = new Date(p.created_at.getTime() - deps.windowDays * 86_400_000);
    const { rows: win } = await c.query<{ id: string; amount_cents: number }>(
      `SELECT id, amount_cents FROM payments
        WHERE account_id = $1 AND id <> $2 AND created_at >= $3 AND status = ANY($4)
        ORDER BY created_at`,
      [p.account_id, p.id, since, LIVE_STATUSES],
    );
    const prior = win.reduce((sum, r) => sum + r.amount_cents, 0);
    await c.query('UPDATE payments SET window_prior_cents = $2, window_payment_ids = $3 WHERE id = $1',
      [p.id, prior, win.map((r) => r.id)]);

    if (prior + p.amount_cents >= deps.thresholdCents) {
      await audit(c, SYSTEM, 'Review threshold reached',
        `7-day total ${formatUsd(prior + p.amount_cents)} ≥ ${formatUsd(deps.thresholdCents)}`, p.id,
        { priorCents: prior, amountCents: p.amount_cents, thresholdCents: deps.thresholdCents });
      return hold(c, p, 'threshold');
    }

    await settleReserved(c, p.account_id, p.amount_cents);
    const { rows } = await c.query<PaymentRow>(
      `UPDATE payments SET status = 'sent', resolved_at = now() WHERE id = $1 RETURNING *`, [p.id]);
    await audit(c, SYSTEM, 'Payment sent', `${formatUsd(p.amount_cents)} debited`, p.id);
    return rows[0]!;
  });
}

async function hold(c: Tx, p: PaymentRow, reason: 'threshold' | 'sanctions_timeout'): Promise<PaymentRow> {
  const { rows } = await c.query<PaymentRow>(
    `UPDATE payments SET status = 'on_hold', hold_reason = $2, held_at = now() WHERE id = $1 RETURNING *`,
    [p.id, reason],
  );
  await audit(c, SYSTEM, 'Payment placed on hold', 'Funds reserved, not sent', p.id);
  return rows[0]!;
}

/**
 * Recovery for payments stuck in `screening` (process crashed or was restarted
 * mid-payment). They are held for compliance, never sent.
 */
export async function sweepStuckScreening(deps: Deps, olderThanMs: number): Promise<number> {
  const { rows } = await deps.db.query<{ id: string }>(
    `SELECT id FROM payments WHERE status = 'screening' AND created_at < now() - make_interval(secs => $1)`,
    [olderThanMs / 1000],
  );
  for (const r of rows) {
    await applyScreeningOutcome(deps, r.id, {
      kind: 'unavailable', reason: 'timeout', message: 'Screening did not complete (recovered by sweeper)',
    });
  }
  return rows.length;
}
