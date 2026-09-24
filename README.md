# Meridian: cross-border payments trial

This is a small working payments platform. It has a customer screen, a compliance review screen, and a Node/TypeScript API over PostgreSQL. All checks run on the server. The browser never talks to the database.

See [SUBMISSION.md](SUBMISSION.md) for assumptions, unfinished work and the sanctions-timeout answer.

## Live demo
**https://payments-compliance-platform.onrender.com** (password `demo1234` for all three test logins below)

> **First load may take 30–60 seconds.** The demo runs on Render's free tier, which puts the server to sleep after 15 minutes without traffic. The first request wakes it up; after that it responds normally. The database (Neon) also pauses when idle and wakes in about a second. No data is lost while either is asleep.

## Stack
- **web/**: React + Vite, implemented from the Claude Design mock.
- **server/**: Fastify, zod and `pg`. Business rules live in `src/services`, and the rules that must hold whatever code writes the row live in `migrations/001_init.sql`.
- **PostgreSQL 16+**: any host works (Supabase, Neon, Render, or local Docker).

## Run locally
```bash
cp .env.example .env
npm install
npm run db:up        # docker compose: Postgres on :5433 with owner + least-privileged app role
npm run db:migrate
npm run db:seed
npm run dev          # API on :4000, web on http://localhost:5173
npm test             # control tests against the meridian_test database
```

## Test logins (password `demo1234`)
| Role | Email |
|---|---|
| Customer | alex@northwind.test |
| Compliance user 1 | priya.shah@meridian.test |
| Compliance user 2 | marcus.lee@meridian.test |

## Sanctions test list (fictional)
Payments to any of these names, or a close spelling variant or typo, are refused. The customer only ever sees "Cannot be processed".

| List entry | Also refused (try these) | Allowed (different name) |
|---|---|---|
| Viktor Orlanov | Victor Orlanoff · Orlanov Viktor | Victoria Orlando |
| Nadia Petrakova | Nadia Petrakowa · Nadai Petrakova | Nadia Peters |
| Karim Zahedi | Kareem Zahedi · Karim Zaehdi | Karen Zahid |
| Oceanic Delta Trading | Oceanic Delta Trading LLC · Oceanic Delta Tradng | Delta Trading Co |
| Soren Malverde | Sören Malverde · Soren Malvedre | Soren Madsen |

Any recipient containing **"Timeout Test"** simulates a screening outage, so the payment is held and never sent. Compliance officers see which list entry matched and the similarity score.

## Demo script
1. Sign in as the customer and use the **1 · Supplier $2,000** chip. The payment is sent and the balance drops by $2,000.
2. Use **2 · Victor Orlanoff** (a spelling variant of *Viktor Orlanov*). The customer sees "Cannot be processed" and no money moves.
3. Use **3 · $7,500 payment**. The 7-day total is $9,500, over the $8,000 threshold, so the payment is shown as "On hold".
4. Sign in as Priya and recommend release. She can't make the final decision herself.
5. Sign in as Marcus and release the payment. The recipient is screened again against the current list, then the money moves, and the full audit trail is visible.
6. **4 · Screening timeout**. The stub screener simulates an outage for any recipient containing "Timeout Test": the first screening never answers, so after 5 seconds the payment fails closed to "On hold". When compliance releases it, screening runs again (the stub answers this time) and must pass before any money moves.

"Reset demo data" on the sign-in page gives the customer a fresh account without deleting any history.

## Security design
- **Every check runs on the server.** The browser only formats values for display. The sanctions list and the threshold rule are never sent to it.
- **Nothing is disclosed to the customer.** Customer API responses are built from an allow-list of fields. A test fails if any customer response mentions sanctions, a match, the threshold or a hold reason.
- **Checks are layered.** The service enforces each rule, the database enforces it again (constraints and triggers), and the app connects with a least-privileged DB role that can't modify audit rows.
- **Sessions:** a random 256-bit token is stored only as a SHA-256 hash. The cookie is `HttpOnly` and `SameSite=Strict`, and `Secure` in production. Sessions expire after 8 hours and are revoked server-side on logout.
- **Passwords:** hashed with scrypt and a per-user salt. A dummy hash is checked for unknown emails, so response timing doesn't reveal which accounts exist. Sign-in locks for 15 minutes after 5 failures per email or per IP.
- **Refused actions are audited too:** failed sign-ins (the password is never logged), wrong-role API calls, and self-approval attempts.
- **Headers:** a strict CSP, `frame-ancestors 'none'`/`X-Frame-Options: DENY`, `nosniff`, `no-referrer`, HSTS in production, and `no-store` on API responses.
- **Input:** zod schemas that reject unknown fields, a 16 KB body limit, and amounts accepted only as strings.
- **Idempotency keys:** a double-click or a retry can't send a payment twice.

## What the tests cover
Each control has a test that attempts the forbidden action and asserts it is refused. See `server/test/controls.test.ts`:
- sanctions exact and variant matches are refused, with no money moved and no reason leaked to the customer
- the threshold hold reserves the funds and doesn't debit them
- every release re-screens: a name added to the list while the payment waits is refused at release, and a screening outage at release moves nothing
- screener timeout, error or crash mid-payment: the payment is held and never sent
- the recommender can't decide, whether through the service, the API, or a raw SQL update
- a payment can't leave `on_hold` without a completed review
- the audit log rejects UPDATE, DELETE and TRUNCATE, for the app role and for the owner
- fractional cents are rejected by the column and by the API, and the available balance can't go negative
- role guards, idempotent payment submission, and a demo reset that keeps history
- sign-in lockout, security headers, cookie flags, server-side logout, and audit entries for refused actions

## Deploy
Live stack: **Render** (free Docker web service, Singapore) and **Neon** (free Postgres, Singapore).

1. In Neon, create the least-privileged role `meridian_app` (`CREATE ROLE meridian_app LOGIN PASSWORD '…'`) and run the migrations and seed as the owner.
2. In Render, create a Blueprint from this repo. `render.yaml` defines the service. Set two secrets:
   - `DATABASE_URL`: `meridian_app` on Neon's **pooled** host
   - `OWNER_DATABASE_URL`: the owner on the **direct** host, used only for migrations at startup
   
   Both need `sslmode=verify-full`, so the database certificate is always verified.
3. On each start the container applies pending migrations, seeds demo data if it's missing, and serves the API and web app on `$PORT`.
4. Point an uptime pinger at `/api/health` every 10 minutes. It doesn't touch the database, so it keeps the free web service warm without spending Neon compute hours.
