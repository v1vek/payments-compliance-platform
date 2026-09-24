import type { Queryable } from './db.js';

export type Actor = { id: string | null; name: string };
export const SYSTEM: Actor = { id: null, name: 'System' };

export async function audit(
  q: Queryable,
  actor: Actor,
  action: string,
  detail: string,
  paymentId: string | null = null,
  data: Record<string, unknown> | null = null,
): Promise<void> {
  await q.query(
    `INSERT INTO audit_events (actor_id, actor_name, action, detail, payment_id, data)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [actor.id, actor.name, action, detail, paymentId, data],
  );
}
