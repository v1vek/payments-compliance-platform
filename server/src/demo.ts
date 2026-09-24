import { tx, type Db } from './db.js';
import { audit, SYSTEM } from './audit.js';
import { formatUsd } from './money.js';

export const DEMO_PASSWORD = 'demo1234';

export const DEMO_USERS = [
  { email: 'alex@northwind.test', name: 'Alex Chen', role: 'customer', label: 'Customer', initials: 'AC' },
  { email: 'priya.shah@meridian.test', name: 'Priya Shah', role: 'compliance', label: 'Compliance user 1', initials: 'PS' },
  { email: 'marcus.lee@meridian.test', name: 'Marcus Lee', role: 'compliance', label: 'Compliance user 2', initials: 'ML' },
] as const;

// Fictional names only.
export const SANCTIONS_LIST = ['Viktor Orlanov', 'Nadia Petrakova', 'Karim Zahedi', 'Oceanic Delta Trading', 'Soren Malverde'];

export const OPENING_BALANCE_CENTS = 2_500_000; // $25,000.00
const HOLDER = 'Northwind Imports Ltd';

/**
 * Gives the demo customer a clean slate so reviewers can replay the three
 * flows. History is never deleted: the current account is closed and a new
 * one opened, and both steps are written to the audit log.
 */
export async function resetDemoCustomer(db: Db): Promise<void> {
  await tx(db, async (c) => {
    const { rows } = await c.query<{ id: string }>(`SELECT id FROM users WHERE email = $1`, [DEMO_USERS[0].email]);
    const owner = rows[0];
    if (!owner) throw new Error('demo customer missing; run the seed');
    const closed = await c.query(
      `UPDATE accounts SET status = 'closed', closed_at = now() WHERE owner_id = $1 AND status = 'active' RETURNING id`,
      [owner.id]);
    await c.query(
      `INSERT INTO accounts (owner_id, holder_name, masked_number, ledger_cents) VALUES ($1, $2, '•••• 2210', $3)`,
      [owner.id, HOLDER, OPENING_BALANCE_CENTS]);
    await audit(c, SYSTEM, 'Demo reset',
      `${closed.rowCount ? 'Previous customer account closed; ' : ''}new account opened with ${formatUsd(OPENING_BALANCE_CENTS)}. No history deleted.`);
  });
}
