import { fileURLToPath } from 'node:url';
import { createPool, tx, type Db } from '../src/db.js';
import { hashPassword } from '../src/auth.js';
import { DEMO_PASSWORD, DEMO_USERS, OPENING_BALANCE_CENTS, SANCTIONS_LIST } from '../src/demo.js';

/**
 * Idempotent seed: users, sanctions list, the customer's account, and one
 * payment from 12 days ago (outside the 7-day window) so the account has history.
 */
export async function seed(db: Db): Promise<void> {
  await tx(db, async (c) => {
    const hash = await hashPassword(DEMO_PASSWORD);
    for (const u of DEMO_USERS) {
      await c.query(
        `INSERT INTO users (email, name, role, label, initials, password_hash) VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (email) DO NOTHING`,
        [u.email, u.name, u.role, u.label, u.initials, hash]);
    }
    for (const name of SANCTIONS_LIST) {
      await c.query('INSERT INTO sanctions_entries (name) VALUES ($1) ON CONFLICT (name) DO NOTHING', [name]);
    }
    const { rows: [cust] } = await c.query<{ id: string; name: string }>(
      'SELECT id, name FROM users WHERE email = $1', [DEMO_USERS[0].email]);
    const existing = await c.query('SELECT 1 FROM accounts WHERE owner_id = $1', [cust!.id]);
    if (existing.rowCount) return;

    const priorCents = 120_000;
    const at = new Date(Date.now() - 12 * 86_400_000);
    const { rows: [acct] } = await c.query<{ id: string }>(
      `INSERT INTO accounts (owner_id, holder_name, masked_number, ledger_cents, opened_at)
       VALUES ($1, 'Northwind Imports Ltd', '•••• 2210', $2, $3) RETURNING id`,
      [cust!.id, OPENING_BALANCE_CENTS + priorCents, new Date(at.getTime() - 30 * 86_400_000)]);
    const { rows: [p] } = await c.query<{ id: string }>(
      `INSERT INTO payments (number, account_id, created_by, recipient, country, account_details, reference,
                             amount_cents, status, created_at, resolved_at)
       VALUES (1038, $1, $2, 'Harbor Freight Co.', 'Singapore', 'DBS •••• 4471', 'INV-2291', $3, 'sent', $4, $4)
       RETURNING id`,
      [acct!.id, cust!.id, priorCents, at]);
    await c.query('UPDATE accounts SET ledger_cents = ledger_cents - $2 WHERE id = $1', [acct!.id, priorCents]);
    const ev = (offsetMs: number, actorId: string | null, actor: string, action: string, detail: string) =>
      c.query(`INSERT INTO audit_events (at, actor_id, actor_name, action, detail, payment_id) VALUES ($1, $2, $3, $4, $5, $6)`,
        [new Date(at.getTime() + offsetMs), actorId, actor, action, detail, p!.id]);
    await ev(0, cust!.id, cust!.name, 'Payment submitted', '$1,200.00 to Harbor Freight Co.');
    await ev(800, null, 'System', 'Sanctions screening passed', 'No match against sanctions list');
    await ev(900, null, 'System', 'Payment sent', '$1,200.00 debited');
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const url = process.env.OWNER_DATABASE_URL || process.env.DATABASE_URL;
  if (!url) throw new Error('Set OWNER_DATABASE_URL or DATABASE_URL');
  const db = createPool(url);
  seed(db).then(() => console.log('seeded'), (err) => { console.error(err); process.exitCode = 1; }).finally(() => db.end());
}
