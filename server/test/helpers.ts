import pg from 'pg';
import { createPool, type Db } from '../src/db.js';
import { migrate } from '../scripts/migrate.js';
import { seed } from '../scripts/seed.js';
import { buildApp } from '../src/app.js';
import { matchName, type SanctionsScreener } from '../src/sanctions.js';
import { SANCTIONS_LIST, DEMO_USERS } from '../src/demo.js';
import type { Deps } from '../src/services/payments.js';
import type { SessionUser } from '../src/auth.js';

export const OWNER_URL = process.env.TEST_OWNER_DATABASE_URL ?? 'postgres://meridian_owner:owner_pw@localhost:5433/meridian_test';
export const APP_URL = process.env.TEST_DATABASE_URL ?? 'postgres://meridian_app:app_pw@localhost:5433/meridian_test';

/** Drops and rebuilds the test schema, then seeds demo data. */
export async function resetDatabase(): Promise<void> {
  const c = new pg.Client({ connectionString: OWNER_URL });
  await c.connect();
  await c.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await c.end();
  await migrate(OWNER_URL, () => {});
  const owner = createPool(OWNER_URL);
  await seed(owner);
  await owner.end();
}

/** Screener whose behaviour each test controls. */
export class FakeScreener implements SanctionsScreener {
  mode: 'normal' | 'hang' | 'error' = 'normal';
  calls = 0;
  /** The provider's current list; tests can add a name to simulate a list update. */
  list: string[] = [...SANCTIONS_LIST];
  async screen(name: string, signal: AbortSignal) {
    this.calls++;
    if (this.mode === 'error') throw new Error('upstream 502');
    if (this.mode === 'hang') {
      await new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))));
    }
    return { match: matchName(name, this.list) };
  }
}

export function makeDeps(db: Db, screener: SanctionsScreener): Deps {
  return { db, screener, sanctionsTimeoutMs: 150, thresholdCents: 800_000, windowDays: 7 };
}

export function makeApp(deps: Deps) {
  return buildApp({ ...deps, sessionHours: 1, demoMode: true, secureCookies: false });
}

export async function userByEmail(db: Db, email: string): Promise<SessionUser> {
  const { rows } = await db.query<SessionUser>('SELECT id, email, name, role, label, initials FROM users WHERE email = $1', [email]);
  return rows[0]!;
}

export const [CUSTOMER, CO1, CO2] = DEMO_USERS.map((u) => u.email) as [string, string, string];

export async function balances(db: Db) {
  const { rows } = await db.query<{ ledger_cents: number; held_cents: number }>(
    `SELECT a.ledger_cents, a.held_cents FROM accounts a JOIN users u ON u.id = a.owner_id
      WHERE u.email = $1 AND a.status = 'active'`, [CUSTOMER]);
  const a = rows[0]!;
  return { ledger: a.ledger_cents, held: a.held_cents, available: a.ledger_cents - a.held_cents };
}
