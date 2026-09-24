# Meridian: submission notes

## Assumptions
- **Sanctions list.** Five fictional names are seeded into `sanctions_entries` in PostgreSQL. Screening sits behind a `SanctionsScreener` port; the demo uses a stub adapter that reads that table.
- **Spelling variants.** Names are normalised (case, accents, punctuation, company suffixes such as Ltd/LLC, phonetic swaps c→k, ph→f, w/v→f, y→i, doubled letters). They are then compared by edit distance, in written order and with the words sorted. Similarity of 85% or more is a match, so "Victor Orlanoff" matches "Viktor Orlanov".
- **Review threshold.** A payment is held when the customer's rolling 7-day total reaches US$8,000 or more, counting the new payment. Sent, on-hold and in-flight payments count. Refused and rejected payments moved no money, so they don't count. The seed's $1,200 payment is 12 days old, so $2,000 + $7,500 = $9,500 triggers review.
- **Order of checks (server only).** Validate → reserve funds → sanctions screen → 7-day threshold → send.
- **Statuses.** Internally the statuses are `screening`, `sent`, `on_hold`, `refused` (sanctions) and `rejected` (compliance). The customer sees Processing, Sent, On hold, or Cannot be processed. Customer API responses are built from an allow-list of fields, so hold reasons never leave the server.
- **Balance.** Funds are reserved when a payment is submitted. Sending debits them. Refusing or rejecting releases the reservation. A held payment is reserved but not debited. A DB constraint keeps the available balance at zero or above.
- **Two-person review.** Either officer may recommend; a *different* officer makes the final decision. The rule is enforced three times: in the service, by a `CHECK` constraint on `payment_reviews`, and by a trigger that won't let a payment leave `on_hold` without a completed review that matches the decision.
- **Audit.** `audit_events` is append-only. The app's DB role has no UPDATE, DELETE or TRUNCATE grant, and a trigger blocks those operations even for the table owner. Payment steps, reviews and sign-ins are all logged.
- **Money.** Amounts are `bigint` cents. The API accepts amounts only as strings and parses them digit by digit; JSON numbers and sub-cent values are rejected.
- **Demo reset.** The reset closes the customer's account and opens a fresh one, and records that in the audit log. Nothing is deleted.

## Unfinished
- Hosted on free tiers (Render + Neon). After 15 minutes without traffic the server sleeps, so the first request can take 30–60 seconds.
- USD only. No FX, fees, real payment rails or double-entry ledger (balances are two columns on `accounts`).
- The sanctions provider is a stub. There's no list-admin UI; the list is seed data.
- Email and password auth with seeded users. The sign-in lockout counts failures in memory, so it resets on restart and is per server instance. No MFA or password reset.
- No browser end-to-end tests. Service and API tests run against real Postgres.

## If sanctions screening times out partway through a payment
The payment is **held, never sent**. Processing has three steps:
1. In a single transaction: reserve the funds, insert the payment as `screening`, and write the audit events.
2. Call the screener outside any transaction, with a 5s deadline.
3. In a single transaction: apply the result.

A timeout or error in step 2 sets the payment to `on_hold` with reason `sanctions_timeout`. The funds stay reserved and the customer sees only "On hold". If the process crashes between steps 1 and 3, the payment is left in `screening` with funds reserved, and a sweeper later moves it to `on_hold`. Either way, no money moves without a clear screening result. When compliance releases the payment, screening runs again and must pass before any funds move. If it's still unavailable, the payment stays on hold.

**Why:** failing closed is the only safe default. A timeout means we have no evidence either way; it doesn't mean the name is clear. Sending money to a sanctioned party can't be undone and is illegal, while a short delay can be fixed. Holding rather than refusing keeps legitimate customers from being penalised for our outage, and keeps a human in the loop.
