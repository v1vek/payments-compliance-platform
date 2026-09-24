import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createPool, type Db } from '../src/db.js';
import { submitPayment, sweepStuckScreening, type Deps, type NewPayment } from '../src/services/payments.js';
import { decide, recommend } from '../src/services/review.js';
import { customerOverview } from '../src/services/views.js';
import type { SessionUser } from '../src/auth.js';
import {
  APP_URL, CO1, CO2, CUSTOMER, FakeScreener, OWNER_URL, balances, makeApp, makeDeps, resetDatabase, userByEmail,
} from './helpers.js';

let db: Db; // least-privileged app role, same as production
let owner: Db;
let screener: FakeScreener;
let deps: Deps;
let customer: SessionUser, co1: SessionUser, co2: SessionUser;

const pay = (recipient: string, dollars: string, extra: Partial<NewPayment> = {}) => {
  const [w, f = ''] = dollars.split('.');
  return submitPayment(deps, customer, {
    recipient, country: 'Germany', accountDetails: 'DE89', reference: 'REF',
    amountCents: Number(w) * 100 + Number((f + '00').slice(0, 2)), ...extra,
  }, null);
};

beforeAll(async () => {
  owner = createPool(OWNER_URL);
});
afterAll(async () => {
  await db?.end();
  await owner.end();
});
beforeEach(async () => {
  await db?.end();
  await resetDatabase();
  db = createPool(APP_URL);
  screener = new FakeScreener();
  deps = makeDeps(db, screener);
  [customer, co1, co2] = await Promise.all([userByEmail(db, CUSTOMER), userByEmail(db, CO1), userByEmail(db, CO2)]);
});

describe('Flow 1 · supplier payment', () => {
  it('sends $2,000 and reduces the balance by exactly 200000 cents', async () => {
    const before = await balances(db);
    const p = await pay('Lindqvist Components GmbH', '2000');
    expect(p.status).toBe('sent');
    expect(p.amount_cents).toBe(200_000);
    const after = await balances(db);
    expect(before.ledger - after.ledger).toBe(200_000);
    expect(after.held).toBe(0);
  });
});

describe('Flow 2 · sanctions list', () => {
  it.each(['Viktor Orlanov', 'Victor Orlanoff'])('refuses "%s" and moves no money', async (name) => {
    const before = await balances(db);
    const p = await pay(name, '1500');
    expect(p.status).toBe('refused');
    expect(p.hold_reason).toBe('sanctions_match');
    expect(await balances(db)).toEqual(before);
  });

  it('customer view shows only "cannot be processed", with no reason', async () => {
    await pay('Victor Orlanoff', '1500');
    const view = await customerOverview(db, customer);
    expect(view.payments[0]!.status).toBe('cannot_be_processed');
    const json = JSON.stringify(view).toLowerCase();
    for (const leak of ['sanction', 'match', 'orlanov', 'hold_reason', 'holdreason', 'screening', 'threshold']) {
      expect(json, leak).not.toContain(leak);
    }
  });

  it('refused payments do not count toward the 7-day review window', async () => {
    await pay('Victor Orlanoff', '5000');
    const p = await pay('Saigon Textile Works', '7500');
    expect(p.status).toBe('sent');
  });
});

describe('Flow 3 · 7-day review threshold', () => {
  it('holds a $7,500 payment when the 7-day total reaches $8,000, reserving not debiting', async () => {
    await pay('Lindqvist Components GmbH', '2000');
    const before = await balances(db);
    const p = await pay('Saigon Textile Works', '7500');
    expect(p.status).toBe('on_hold');
    expect(p.hold_reason).toBe('threshold');
    expect(p.window_prior_cents).toBe(200_000);
    const after = await balances(db);
    expect(after.ledger).toBe(before.ledger);
    expect(after.held).toBe(750_000);
    const view = await customerOverview(db, customer);
    expect(view.payments[0]!.status).toBe('on_hold');
    expect(JSON.stringify(view).toLowerCase()).not.toContain('threshold');
  });

  it('payments older than 7 days are outside the window', async () => {
    // The seeded $1,200 payment is 12 days old; $7,500 alone is under $8,000.
    const p = await pay('Saigon Textile Works', '7500');
    expect(p.status).toBe('sent');
  });

  it('two different officers release it; money moves only after the final decision', async () => {
    await pay('Lindqvist Components GmbH', '2000');
    const p = await pay('Saigon Textile Works', '7500');
    await recommend(deps, co1, p.id, 'release', 'Known supplier');
    expect((await balances(db)).held).toBe(750_000);
    const ledgerBefore = (await balances(db)).ledger;
    await decide(deps, co2, p.id, 'release', '');
    const after = await balances(db);
    expect(ledgerBefore - after.ledger).toBe(750_000);
    expect(after.held).toBe(0);
  });

  it('rejection returns the reservation and the customer sees "cannot be processed"', async () => {
    await pay('Lindqvist Components GmbH', '2000');
    const before = await balances(db);
    const p = await pay('Saigon Textile Works', '7500');
    await recommend(deps, co2, p.id, 'reject', '');
    await decide(deps, co1, p.id, 'reject', '');
    expect(await balances(db)).toEqual(before);
    const view = await customerOverview(db, customer);
    expect(view.payments.find((x) => x.id === p.id)!.status).toBe('cannot_be_processed');
  });
});

describe('Two-person review', () => {
  const heldPayment = async () => {
    await pay('Lindqvist Components GmbH', '2000');
    return pay('Saigon Textile Works', '7500');
  };

  it('the recommending officer cannot make the final decision', async () => {
    const p = await heldPayment();
    await recommend(deps, co1, p.id, 'release', '');
    await expect(decide(deps, co1, p.id, 'release', '')).rejects.toMatchObject({ status: 403 });
    expect((await balances(db)).held).toBe(750_000);
  });

  it('a final decision requires a recommendation first', async () => {
    const p = await heldPayment();
    await expect(decide(deps, co2, p.id, 'release', '')).rejects.toMatchObject({ code: 'recommendation_required' });
  });

  it('a second recommendation and a second decision are refused', async () => {
    const p = await heldPayment();
    await recommend(deps, co1, p.id, 'release', '');
    await expect(recommend(deps, co2, p.id, 'reject', '')).rejects.toMatchObject({ code: 'already_recommended' });
    await decide(deps, co2, p.id, 'release', '');
    await expect(decide(deps, co2, p.id, 'reject', '')).rejects.toMatchObject({ status: 409 });
  });

  it('the database itself rejects a self-approved review, even bypassing the service', async () => {
    const p = await heldPayment();
    await recommend(deps, co1, p.id, 'release', '');
    await expect(db.query(
      `UPDATE payment_reviews SET decided_by = $2, decision = 'release', decided_at = now() WHERE payment_id = $1`,
      [p.id, co1.id])).rejects.toThrow(/four_eyes/);
  });

  it('the database refuses to move a held payment to sent without a completed review', async () => {
    const p = await heldPayment();
    await expect(db.query(`UPDATE payments SET status = 'sent' WHERE id = $1`, [p.id]))
      .rejects.toThrow(/without a final review decision/);
    await recommend(deps, co1, p.id, 'reject', '');
    await decide(deps, co2, p.id, 'reject', '');
    await expect(db.query(`UPDATE payments SET status = 'sent' WHERE id = $1`, [p.id]))
      .rejects.toThrow(/illegal payment transition/);
  });
});

describe('Every release is re-screened against the current list', () => {
  const heldPayment = async (recipient = 'Saigon Textile Works') => {
    await pay('Lindqvist Components GmbH', '2000');
    return pay(recipient, '7500');
  };

  it('a threshold hold is screened again on release before money moves', async () => {
    const p = await heldPayment();
    await recommend(deps, co1, p.id, 'release', '');
    const callsBefore = screener.calls;
    await decide(deps, co2, p.id, 'release', '');
    expect(screener.calls).toBe(callsBefore + 1);
  });

  it('a name added to the list while the payment waited is caught at release', async () => {
    const before = await balances(db);
    const p = await heldPayment('Meridian Shell Holdings');
    await recommend(deps, co1, p.id, 'release', '');
    screener.list.push('Meridian Shell Holdings'); // list updated after the original screening
    await decide(deps, co2, p.id, 'release', '');
    const { rows } = await db.query(`SELECT status FROM payments WHERE id = $1`, [p.id]);
    expect(rows[0].status).toBe('refused');
    const after = await balances(db);
    expect(after.held).toBe(0);
    expect(before.ledger - after.ledger).toBe(200_000); // only the first $2,000 left the account
    const view = await customerOverview(db, customer);
    expect(view.payments.find((x) => x.id === p.id)!.status).toBe('cannot_be_processed');
  });

  it('if screening is down at release time, a threshold hold stays on hold and nothing moves', async () => {
    const p = await heldPayment();
    await recommend(deps, co1, p.id, 'release', '');
    screener.mode = 'hang';
    const before = await balances(db);
    await expect(decide(deps, co2, p.id, 'release', '')).rejects.toMatchObject({ code: 'screening_unavailable' });
    expect(await balances(db)).toEqual(before);
    const { rows } = await db.query(`SELECT p.status, r.decided_by FROM payments p JOIN payment_reviews r ON r.payment_id = p.id WHERE p.id = $1`, [p.id]);
    expect(rows[0]).toMatchObject({ status: 'on_hold', decided_by: null });
  });

  it('rejection needs no screening: it moves no money', async () => {
    const p = await heldPayment();
    await recommend(deps, co1, p.id, 'reject', '');
    screener.mode = 'hang';
    await decide(deps, co2, p.id, 'reject', '');
    const { rows } = await db.query(`SELECT status FROM payments WHERE id = $1`, [p.id]);
    expect(rows[0].status).toBe('rejected');
  });
});

describe('Sanctions screening failure fails closed', () => {
  it.each(['hang', 'error'] as const)('screener %s: payment held, never sent, funds reserved', async (mode) => {
    screener.mode = mode;
    const before = await balances(db);
    const p = await pay('Lindqvist Components GmbH', '500');
    expect(p.status).toBe('on_hold');
    expect(p.hold_reason).toBe('sanctions_timeout');
    const after = await balances(db);
    expect(after.ledger).toBe(before.ledger);
    expect(after.held).toBe(50_000);
    const { rows } = await db.query(`SELECT action FROM audit_events WHERE payment_id = $1`, [p.id]);
    expect(rows.map((r) => r.action)).not.toContain('Payment sent');
  });

  it('release of a timed-out payment re-screens first; if still unavailable nothing moves', async () => {
    screener.mode = 'hang';
    const p = await pay('Lindqvist Components GmbH', '500');
    await recommend(deps, co1, p.id, 'release', '');
    await expect(decide(deps, co2, p.id, 'release', '')).rejects.toMatchObject({ code: 'screening_unavailable' });
    const { rows } = await db.query(`SELECT p.status, r.decided_by FROM payments p JOIN payment_reviews r ON r.payment_id = p.id WHERE p.id = $1`, [p.id]);
    expect(rows[0]).toMatchObject({ status: 'on_hold', decided_by: null });

    screener.mode = 'normal';
    await decide(deps, co2, p.id, 'release', '');
    const { rows: after } = await db.query(`SELECT status FROM payments WHERE id = $1`, [p.id]);
    expect(after[0].status).toBe('sent');
  });

  it('release of a timed-out payment to a sanctioned name is refused on re-screen', async () => {
    screener.mode = 'hang';
    const before = await balances(db);
    const p = await pay('Victor Orlanoff', '500');
    expect(p.status).toBe('on_hold');
    screener.mode = 'normal';
    await recommend(deps, co1, p.id, 'release', '');
    await decide(deps, co2, p.id, 'release', '');
    const { rows } = await db.query(`SELECT status FROM payments WHERE id = $1`, [p.id]);
    expect(rows[0].status).toBe('refused');
    expect(await balances(db)).toEqual(before);
  });

  it('a payment interrupted mid-screening (process crash) is recovered to on_hold by the sweeper', async () => {
    const { rows: [acct] } = await db.query(`SELECT id FROM accounts WHERE owner_id = $1 AND status = 'active'`, [customer.id]);
    await owner.query(`UPDATE accounts SET held_cents = held_cents + 30000 WHERE id = $1`, [acct.id]);
    const { rows: [stuck] } = await owner.query(
      `INSERT INTO payments (account_id, created_by, recipient, country, account_details, reference, amount_cents, status, created_at)
       VALUES ($1, $2, 'Crashed Mid Payment Ltd', 'India', '—', '—', 30000, 'screening', now() - interval '10 minutes') RETURNING id`,
      [acct.id, customer.id]);
    expect(await sweepStuckScreening(deps, 60_000)).toBe(1);
    const { rows } = await db.query(`SELECT status, hold_reason FROM payments WHERE id = $1`, [stuck.id]);
    expect(rows[0]).toEqual({ status: 'on_hold', hold_reason: 'sanctions_timeout' });
    expect((await balances(db)).held).toBe(30_000);
  });
});

describe('Audit history is immutable', () => {
  it('the app role cannot UPDATE, DELETE or TRUNCATE audit events', async () => {
    await pay('Lindqvist Components GmbH', '2000');
    await expect(db.query(`UPDATE audit_events SET detail = 'edited'`)).rejects.toThrow(/permission denied/);
    await expect(db.query(`DELETE FROM audit_events`)).rejects.toThrow(/permission denied/);
    await expect(db.query(`TRUNCATE audit_events`)).rejects.toThrow(/permission denied/);
  });

  it('even the table owner is blocked by the append-only trigger', async () => {
    await expect(owner.query(`UPDATE audit_events SET detail = 'edited'`)).rejects.toThrow(/append-only/);
    await expect(owner.query(`DELETE FROM audit_events`)).rejects.toThrow(/append-only/);
    await expect(owner.query(`TRUNCATE audit_events`)).rejects.toThrow(/append-only/);
  });

  it('records every step of a payment and review', async () => {
    await pay('Lindqvist Components GmbH', '2000');
    const p = await pay('Saigon Textile Works', '7500');
    await recommend(deps, co1, p.id, 'release', '');
    await decide(deps, co2, p.id, 'release', '');
    const { rows } = await db.query(`SELECT actor_name, action FROM audit_events WHERE payment_id = $1 ORDER BY id`, [p.id]);
    expect(rows.map((r) => r.action)).toEqual([
      'Payment submitted', 'Sanctions screening started', 'Sanctions screening passed', 'Review threshold reached',
      'Payment placed on hold', 'Recommended release', 'Final decision: release', 'Re-screening passed', 'Payment sent',
    ]);
    expect(rows.find((r) => r.action === 'Recommended release').actor_name).toBe('Priya Shah');
    expect(rows.find((r) => r.action === 'Final decision: release').actor_name).toBe('Marcus Lee');
  });
});

describe('Money is whole cents in the database', () => {
  it('rejects fractional cents and non-positive amounts at the column level', async () => {
    const { rows: [acct] } = await db.query(`SELECT id FROM accounts WHERE owner_id = $1 AND status = 'active'`, [customer.id]);
    const insert = (amount: string) => owner.query(
      `INSERT INTO payments (account_id, created_by, recipient, country, account_details, reference, amount_cents, status)
       VALUES ($1, $2, 'X', 'India', '—', '—', $3, 'sent')`, [acct.id, customer.id, amount]);
    await expect(insert('10.5')).rejects.toThrow(/invalid input syntax for type bigint/);
    await expect(insert('0')).rejects.toThrow(/amount_cents_check/);
  });

  it('available balance can never go negative', async () => {
    await expect(pay('Lindqvist Components GmbH', '30000')).rejects.toMatchObject({ code: 'insufficient_funds' });
    await expect(db.query(`UPDATE accounts SET held_cents = ledger_cents + 1`)).rejects.toThrow(/available_not_negative/);
  });
});

describe('HTTP boundary', () => {
  let app: FastifyInstance;
  const login = async (email: string) => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'demo1234' } });
    expect(res.statusCode).toBe(200);
    const c = res.cookies.find((x) => x.name === 'meridian_session')!;
    return { cookie: `${c.name}=${c.value}` };
  };
  const body = { recipient: 'Lindqvist Components GmbH', country: 'Germany', account: 'DE89', reference: 'PO-1', amount: '2000.00' };

  beforeEach(async () => { app = makeApp(deps); await app.ready(); });

  it('unauthenticated requests are refused', async () => {
    for (const url of ['/api/customer/overview', '/api/compliance/payments', '/api/compliance/audit']) {
      expect((await app.inject({ url })).statusCode, url).toBe(401);
    }
  });

  it('wrong password is refused without revealing which part was wrong', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: CUSTOMER, password: 'nope' } });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.message).toBe('Email or password is incorrect.');
  });

  it('a customer cannot reach compliance endpoints, and compliance cannot make payments', async () => {
    const cust = await login(CUSTOMER);
    expect((await app.inject({ url: '/api/compliance/payments', headers: cust })).statusCode).toBe(403);
    expect((await app.inject({ url: '/api/compliance/audit', headers: cust })).statusCode).toBe(403);
    const officer = await login(CO1);
    expect((await app.inject({ method: 'POST', url: '/api/customer/payments', headers: officer, payload: body })).statusCode).toBe(403);
  });

  it('rejects numeric JSON amounts, sub-cent amounts and unknown fields', async () => {
    const h = await login(CUSTOMER);
    for (const payload of [{ ...body, amount: 2000 }, { ...body, amount: '20.005' }, { ...body, status: 'sent' }]) {
      const res = await app.inject({ method: 'POST', url: '/api/customer/payments', headers: h, payload });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
    }
    expect((await balances(db)).ledger).toBe(2_500_000);
  });

  it('the same idempotency key sends the payment once', async () => {
    const h = { ...(await login(CUSTOMER)), 'idempotency-key': 'test-key-123456' };
    const a = await app.inject({ method: 'POST', url: '/api/customer/payments', headers: h, payload: body });
    const b = await app.inject({ method: 'POST', url: '/api/customer/payments', headers: h, payload: body });
    expect(a.json().payment.id).toBe(b.json().payment.id);
    expect((await balances(db)).ledger).toBe(2_500_000 - 200_000);
    const reused = await app.inject({ method: 'POST', url: '/api/customer/payments', headers: h, payload: { ...body, amount: '1.00' } });
    expect(reused.statusCode).toBe(409);
  });

  it('customer responses for a sanctions refusal carry no reason', async () => {
    const h = await login(CUSTOMER);
    const res = await app.inject({ method: 'POST', url: '/api/customer/payments', headers: h, payload: { ...body, recipient: 'Victor Orlanoff' } });
    expect(res.json().payment.status).toBe('cannot_be_processed');
    expect(res.body.toLowerCase()).not.toMatch(/sanction|match|orlanov|reason/);
  });

  it('the recommender is refused at the API as well', async () => {
    await pay('Lindqvist Components GmbH', '2000');
    const p = await pay('Saigon Textile Works', '7500');
    const h = await login(CO1);
    const rec = await app.inject({ method: 'POST', url: `/api/compliance/payments/${p.id}/recommendation`, headers: h, payload: { action: 'release' } });
    expect(rec.statusCode).toBe(200);
    const dec = await app.inject({ method: 'POST', url: `/api/compliance/payments/${p.id}/decision`, headers: h, payload: { action: 'release' } });
    expect(dec.statusCode).toBe(403);
  });

  it('demo reset opens a fresh account without deleting any history', async () => {
    await pay('Lindqvist Components GmbH', '2000');
    const { rows: [{ n: before }] } = await db.query('SELECT count(*)::int AS n FROM audit_events');
    expect((await app.inject({ method: 'POST', url: '/api/demo/reset' })).statusCode).toBe(200);
    const { rows: [{ n: after }] } = await db.query('SELECT count(*)::int AS n FROM audit_events');
    expect(after).toBe(before + 1);
    expect(await balances(db)).toEqual({ ledger: 2_500_000, held: 0, available: 2_500_000 });
    const { rows } = await db.query('SELECT count(*)::int AS n FROM payments');
    expect(rows[0].n).toBe(2);
  });
});

describe('Security hardening', () => {
  let app: FastifyInstance;
  beforeEach(async () => { app = makeApp(deps); await app.ready(); });
  const attempt = (email: string, password: string) =>
    app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password } });

  it('locks sign-in after 5 failures, even with the right password, and audits each failure', async () => {
    for (let i = 0; i < 5; i++) expect((await attempt(CUSTOMER, 'wrong')).statusCode).toBe(401);
    const locked = await attempt(CUSTOMER, 'demo1234');
    expect(locked.statusCode).toBe(429);
    const { rows } = await db.query(`SELECT count(*)::int AS n FROM audit_events WHERE action = 'Sign-in failed'`);
    expect(rows[0].n).toBe(5);
    const { rows: detail } = await db.query(`SELECT detail FROM audit_events WHERE action = 'Sign-in failed'`);
    expect(JSON.stringify(detail)).not.toContain('wrong');
  });

  it('health check answers without a session', async () => {
    const res = await app.inject({ url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });

  it('sends security headers on every response', async () => {
    const res = await app.inject({ url: '/api/config' });
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('session cookie is HttpOnly and SameSite=Strict', async () => {
    const res = await attempt(CUSTOMER, 'demo1234');
    const c = res.cookies.find((x) => x.name === 'meridian_session')!;
    expect(c.httpOnly).toBe(true);
    expect(c.sameSite).toBe('Strict');
  });

  it('audits refused actions: wrong-role access and self-approval attempts', async () => {
    const login = await attempt(CUSTOMER, 'demo1234');
    const c = login.cookies.find((x) => x.name === 'meridian_session')!;
    await app.inject({ url: '/api/compliance/audit', headers: { cookie: `${c.name}=${c.value}` } });
    await pay('Lindqvist Components GmbH', '2000');
    const p = await pay('Saigon Textile Works', '7500');
    await recommend(deps, co1, p.id, 'release', '');
    await expect(decide(deps, co1, p.id, 'release', '')).rejects.toMatchObject({ status: 403 });
    const { rows } = await db.query(`SELECT actor_name, action FROM audit_events WHERE action LIKE 'Blocked:%' ORDER BY id`);
    expect(rows).toEqual([
      { actor_name: 'Alex Chen', action: 'Blocked: access denied' },
      { actor_name: 'Priya Shah', action: 'Blocked: self-approval attempt' },
    ]);
  });

  it('logout invalidates the session server-side', async () => {
    const login = await attempt(CUSTOMER, 'demo1234');
    const c = login.cookies.find((x) => x.name === 'meridian_session')!;
    const cookie = `${c.name}=${c.value}`;
    await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie }, payload: {} });
    expect((await app.inject({ url: '/api/customer/overview', headers: { cookie } })).statusCode).toBe(401);
  });
});
