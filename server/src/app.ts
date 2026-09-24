import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import { z } from 'zod';
import type { Db } from './db.js';
import { AppError, forbidden } from './errors.js';
import { login, logout, userForToken, type Role, type SessionUser } from './auth.js';
import { MAX_PAYMENT_CENTS, parseCents } from './money.js';
import { submitPayment, type Deps } from './services/payments.js';
import { decide, recommend } from './services/review.js';
import { auditLog, customerOverview, flaggedPayments, paymentDetail, toCustomerPayment } from './services/views.js';
import { resetDemoCustomer } from './demo.js';
import { audit } from './audit.js';
import { FailureThrottle } from './throttle.js';

export const COUNTRIES = ['Germany', 'India', 'Mexico', 'Singapore', 'United Kingdom', 'Vietnam'] as const;
const SESSION_COOKIE = 'meridian_session';

export type AppOptions = Deps & { sessionHours: number; demoMode: boolean; secureCookies: boolean; logger?: boolean };

declare module 'fastify' {
  interface FastifyRequest {
    user: SessionUser | null;
  }
}

const text = (max: number) => z.string().trim().max(max);

const paymentBody = z.object({
  recipient: text(140).min(1, 'Enter a recipient name.'),
  country: z.enum(COUNTRIES),
  account: text(64).default(''),
  reference: text(64).default(''),
  // A string, never a JSON number: money doesn't pass through a float on the way in.
  amount: z.string().max(20),
}).strict();

const reviewBody = z.object({
  action: z.enum(['release', 'reject']),
  note: text(1000).default(''),
}).strict();

const loginBody = z.object({ email: z.string().max(254), password: z.string().max(200) }).strict();
const idParam = z.object({ id: z.string().uuid() });
const idempotencyKey = z.string().min(8).max(128).regex(/^[A-Za-z0-9_-]+$/);

export function buildApp(opts: AppOptions) {
  // trustProxy: hosted platforms terminate TLS at a proxy; req.ip must be the client.
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 16 * 1024, trustProxy: true });
  const db: Db = opts.db;
  const loginThrottle = new FailureThrottle(5, 15 * 60_000);

  app.addHook('onSend', async (req, reply) => {
    reply.header('Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
      "font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; " +
      "base-uri 'none'; form-action 'self'");
    reply.header('X-Frame-Options', 'DENY');
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    if (req.url.startsWith('/api/')) reply.header('Cache-Control', 'no-store');
    if (opts.secureCookies) reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  });

  app.register(cookie);
  app.decorateRequest('user', null);

  app.addHook('preHandler', async (req) => {
    req.user = await userForToken(db, req.cookies[SESSION_COOKIE]);
  });

  app.setErrorHandler((err: unknown, req, reply) => {
    if (err instanceof AppError) {
      return reply.status(err.status).send({ error: { code: err.code, message: err.message } });
    }
    if (err instanceof z.ZodError) {
      const first = err.issues[0];
      return reply.status(400).send({ error: { code: 'invalid_request', message: first?.message ?? 'Invalid request.', issues: err.issues } });
    }
    const e = err as { statusCode?: number; message?: string };
    if (e.statusCode && e.statusCode < 500) {
      return reply.status(e.statusCode).send({ error: { code: 'bad_request', message: e.message ?? 'Bad request.' } });
    }
    req.log.error(err);
    return reply.status(500).send({ error: { code: 'internal', message: 'Something went wrong.' } });
  });

  const requireRole = (role: Role) => async (req: FastifyRequest) => {
    if (!req.user) throw new AppError(401, 'unauthenticated', 'Please sign in.');
    if (req.user.role !== role) {
      await audit(db, req.user, 'Blocked: access denied', `${req.user.label} requested ${req.method} ${req.routeOptions.url}`);
      throw forbidden();
    }
  };
  const me = (req: FastifyRequest) => req.user!;

  // --- auth -----------------------------------------------------------------

  app.post('/api/auth/login', async (req, reply) => {
    const body = loginBody.parse(req.body);
    const keys = [`ip:${req.ip}`, `email:${body.email.trim().toLowerCase()}`];
    if (keys.some((k) => loginThrottle.isLocked(k))) {
      throw new AppError(429, 'too_many_attempts', 'Too many sign-in attempts. Try again in 15 minutes.');
    }
    let result;
    try {
      result = await login(db, body.email, body.password, opts.sessionHours);
    } catch (err) {
      if (err instanceof AppError && err.status === 401) keys.forEach((k) => loginThrottle.fail(k));
      throw err;
    }
    loginThrottle.clear(keys[1]!); // per-IP failures persist, so one valid account can't reset them
    const { token, user } = result;
    reply.setCookie(SESSION_COOKIE, token, {
      path: '/', httpOnly: true, sameSite: 'strict', secure: opts.secureCookies,
      maxAge: opts.sessionHours * 3600,
    });
    return { user };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const token = req.cookies[SESSION_COOKIE];
    if (token && req.user) await logout(db, token, req.user);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/api/auth/me', async (req) => ({ user: req.user }));

  app.get('/api/config', async () => ({ demoMode: opts.demoMode }));

  app.post('/api/demo/reset', async (_req, reply: FastifyReply) => {
    if (!opts.demoMode) throw new AppError(404, 'not_found', 'Not found.');
    await resetDemoCustomer(db);
    return reply.send({ ok: true });
  });

  // --- customer -------------------------------------------------------------

  app.get('/api/customer/overview', { preHandler: requireRole('customer') }, async (req) =>
    customerOverview(db, me(req)));

  app.post('/api/customer/payments', { preHandler: requireRole('customer') }, async (req, reply) => {
    const body = paymentBody.parse(req.body);
    const rawKey = req.headers['idempotency-key'];
    const key = rawKey === undefined ? null : idempotencyKey.parse(rawKey);
    const cents = parseCents(body.amount);
    if (cents === null || cents <= 0) throw new AppError(400, 'invalid_amount', 'Enter a valid amount.');
    if (cents > MAX_PAYMENT_CENTS) throw new AppError(400, 'invalid_amount', 'Amount is above the single-payment limit.');
    const payment = await submitPayment(opts, me(req), {
      recipient: body.recipient,
      country: body.country,
      accountDetails: body.account || '—',
      reference: body.reference || '—',
      amountCents: cents,
    }, key);
    return reply.status(201).send({ payment: toCustomerPayment(payment) });
  });

  // --- compliance -----------------------------------------------------------

  app.get('/api/compliance/payments', { preHandler: requireRole('compliance') }, async () =>
    ({ payments: await flaggedPayments(db) }));

  app.get('/api/compliance/payments/:id', { preHandler: requireRole('compliance') }, async (req) =>
    paymentDetail(db, idParam.parse(req.params).id));

  app.post('/api/compliance/payments/:id/recommendation', { preHandler: requireRole('compliance') }, async (req) => {
    const { id } = idParam.parse(req.params);
    const body = reviewBody.parse(req.body);
    await recommend(opts, me(req), id, body.action, body.note);
    return paymentDetail(db, id);
  });

  app.post('/api/compliance/payments/:id/decision', { preHandler: requireRole('compliance') }, async (req) => {
    const { id } = idParam.parse(req.params);
    const body = reviewBody.parse(req.body);
    await decide(opts, me(req), id, body.action, body.note);
    return paymentDetail(db, id);
  });

  app.get('/api/compliance/audit', { preHandler: requireRole('compliance') }, async () => auditLog(db));

  return app;
}
