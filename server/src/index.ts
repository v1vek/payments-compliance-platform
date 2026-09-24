import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fastifyStatic from '@fastify/static';
import { buildApp } from './app.js';
import { config } from './config.js';
import { createPool } from './db.js';
import { StubSanctionsScreener } from './sanctions.js';
import { sweepStuckScreening, type Deps } from './services/payments.js';

const db = createPool(config.databaseUrl);
const deps: Deps = {
  db,
  screener: new StubSanctionsScreener(db),
  sanctionsTimeoutMs: config.sanctionsTimeoutMs,
  thresholdCents: config.reviewThresholdCents,
  windowDays: config.windowDays,
};

const app = buildApp({ ...deps, sessionHours: config.sessionHours, demoMode: config.demoMode, secureCookies: config.secureCookies, logger: true });

// In production the API also serves the built React app from one origin.
const webDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../web/dist');
if (existsSync(webDist)) {
  app.register(fastifyStatic, { root: webDist });
  app.setNotFoundHandler((req, reply) =>
    req.url.startsWith('/api/') ? reply.status(404).send({ error: { code: 'not_found', message: 'Not found.' } }) : reply.sendFile('index.html'));
}

// Anything still `screening` well past the screening deadline was interrupted
// mid-payment. Hold it for compliance; never send it.
const sweepAfterMs = config.sanctionsTimeoutMs + 30_000;
const sweep = () => sweepStuckScreening(deps, sweepAfterMs)
  .then((n) => { if (n) app.log.warn(`sweeper held ${n} interrupted payment(s)`); })
  .catch((err) => app.log.error(err, 'sweeper failed'));
const sweeper = setInterval(sweep, 15_000);

app.listen({ port: config.port, host: '0.0.0.0' }).then(sweep);

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    clearInterval(sweeper);
    await app.close();
    await db.end();
    process.exit(0);
  });
}
