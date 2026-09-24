import { tx } from '../db.js';
import { audit, SYSTEM, type Actor } from '../audit.js';
import { AppError, conflict, forbidden, notFound } from '../errors.js';
import { formatUsd } from '../money.js';
import { screenWithTimeout, type ScreeningOutcome } from '../sanctions.js';
import type { SessionUser } from '../auth.js';
import { releaseReserved, settleReserved, type Deps, type PaymentRow } from './payments.js';

export type Action = 'release' | 'reject';

type ReviewRow = { recommended_by: string; recommendation: Action; decided_by: string | null };

const notOnHold = () => conflict('not_on_hold', 'This payment is no longer on hold.');

async function load(deps: Deps, paymentId: string) {
  const { rows } = await deps.db.query<PaymentRow>('SELECT * FROM payments WHERE id = $1', [paymentId]);
  if (!rows[0]) throw notFound('Payment');
  const review = await deps.db.query<ReviewRow>(
    'SELECT recommended_by, recommendation, decided_by FROM payment_reviews WHERE payment_id = $1', [paymentId]);
  return { payment: rows[0], review: review.rows[0] ?? null };
}

export async function recommend(deps: Deps, user: SessionUser, paymentId: string, action: Action, note: string) {
  const actor: Actor = { id: user.id, name: user.name };
  await tx(deps.db, async (c) => {
    const { rows } = await c.query<PaymentRow>('SELECT * FROM payments WHERE id = $1 FOR UPDATE', [paymentId]);
    const p = rows[0];
    if (!p) throw notFound('Payment');
    if (p.status !== 'on_hold') throw notOnHold();
    const inserted = await c.query(
      `INSERT INTO payment_reviews (payment_id, recommended_by, recommendation, recommendation_note)
       VALUES ($1, $2, $3, $4) ON CONFLICT (payment_id) DO NOTHING`,
      [p.id, user.id, action, note],
    );
    if (inserted.rowCount !== 1) throw conflict('already_recommended', 'A recommendation already exists.');
    await audit(c, actor, action === 'release' ? 'Recommended release' : 'Recommended rejection', note || 'No note', p.id);
  });
}

export async function decide(deps: Deps, user: SessionUser, paymentId: string, action: Action, note: string) {
  const actor: Actor = { id: user.id, name: user.name };

  // Cheap pre-checks so we don't call the screener for a request that will be refused.
  const pre = await load(deps, paymentId);
  if (pre.review && pre.review.recommended_by === user.id && !pre.review.decided_by) {
    await audit(deps.db, actor, 'Blocked: self-approval attempt',
      'The recommending officer tried to make the final decision; refused', paymentId);
  }
  assertCanDecide(pre.payment, pre.review, user);

  // A payment held because screening never answered must pass screening before
  // any money moves. This is a network call, so it happens outside the transaction.
  let rescreen: ScreeningOutcome | null = null;
  if (action === 'release' && pre.payment.hold_reason === 'sanctions_timeout') {
    rescreen = await screenWithTimeout(deps.screener, pre.payment.recipient, deps.sanctionsTimeoutMs, 'rescreen');
    if (rescreen.kind === 'unavailable') {
      await audit(deps.db, SYSTEM, 'Re-screening timed out', 'Screening still unavailable · payment remains on hold', paymentId);
      throw new AppError(503, 'screening_unavailable',
        'Sanctions screening is still unavailable, so the payment stays on hold. Try again shortly.');
    }
  }

  await tx(deps.db, async (c) => {
    await c.query('SELECT 1 FROM accounts WHERE id = $1 FOR UPDATE', [pre.payment.account_id]);
    const { rows } = await c.query<PaymentRow>('SELECT * FROM payments WHERE id = $1 FOR UPDATE', [paymentId]);
    const p = rows[0]!;
    const { rows: rv } = await c.query<ReviewRow>(
      'SELECT recommended_by, recommendation, decided_by FROM payment_reviews WHERE payment_id = $1 FOR UPDATE', [paymentId]);
    assertCanDecide(p, rv[0] ?? null, user); // re-check under lock

    await c.query(
      `UPDATE payment_reviews SET decided_by = $2, decision = $3, decision_note = $4, decided_at = now()
        WHERE payment_id = $1`,
      [p.id, user.id, action, note],
    );
    await audit(c, actor, `Final decision: ${action}`, note || 'No note', p.id);

    if (action === 'reject') {
      await releaseReserved(c, p.account_id, p.amount_cents);
      await c.query(`UPDATE payments SET status = 'rejected', resolved_at = now() WHERE id = $1`, [p.id]);
      await audit(c, SYSTEM, 'Payment rejected', 'Reserved funds returned to customer · customer shown “cannot be processed”', p.id);
      return;
    }

    if (rescreen?.kind === 'match') {
      await audit(c, SYSTEM, 'Re-screening: sanctions match', `“${p.recipient}” matched “${rescreen.match.entry}”`, p.id, rescreen.match);
      await releaseReserved(c, p.account_id, p.amount_cents);
      await c.query(`UPDATE payments SET status = 'refused', screening = $2, resolved_at = now() WHERE id = $1`,
        [p.id, { ...rescreen.match, input: p.recipient }]);
      await audit(c, SYSTEM, 'Payment refused', 'Reserved funds returned · no funds sent', p.id);
      return;
    }
    if (rescreen?.kind === 'clear') {
      await audit(c, SYSTEM, 'Re-screening passed', 'No match against sanctions list', p.id);
    }

    await settleReserved(c, p.account_id, p.amount_cents);
    await c.query(`UPDATE payments SET status = 'sent', resolved_at = now() WHERE id = $1`, [p.id]);
    await audit(c, SYSTEM, 'Payment sent', `${formatUsd(p.amount_cents)} debited`, p.id);
  });
}

function assertCanDecide(p: PaymentRow, review: ReviewRow | null, user: SessionUser) {
  if (p.status !== 'on_hold') throw notOnHold();
  if (!review) throw conflict('recommendation_required', 'A recommendation is required first.');
  if (review.decided_by) throw conflict('already_decided', 'A final decision has already been made.');
  if (review.recommended_by === user.id) {
    throw forbidden('The recommending officer cannot make the final decision.');
  }
}
