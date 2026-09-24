# Meridian: submission notes

## Assumptions
- **Sanctions list:** five fictional names stored in Postgres and screened server-side through a provider interface (a stub adapter here).
- **Spelling variants:** names are normalised (case, accents, punctuation, Ltd/LLC, c/k, ph/f, v/w) and compared by edit distance in either word order. Similarity of 85% or more is a match.
- **Threshold:** a payment is held when the rolling 7-day total, including it, reaches $8,000. Sent, held and in-flight payments count; refused and rejected ones don't.
- **Order of checks:** validate → reserve funds → sanctions → threshold → send.
- **Statuses:** `screening`, `sent`, `on_hold`, `refused`, `rejected`. The customer sees only Processing, Sent, On hold or Cannot be processed.
- **Balance:** funds are reserved on submit, debited when sent, and returned on refusal or rejection.
- **Review:** either officer may recommend; a different officer decides and may overrule. Every release is re-screened against the current list.
- **History:** append-only. The app's database role can't update or delete audit rows, and a trigger blocks the owner too.
- **Money:** integer cents (`bigint`), parsed from strings, never floats.
- **Demo:** any recipient containing "Timeout Test" simulates a screening outage. "Reset demo data" opens a fresh customer account without deleting history.

## Unfinished
USD only: no FX, fees, real payment rails or double-entry ledger. The screening provider is a stub, and there's no list admin, MFA or password reset. On free hosting, the first load after 15 idle minutes takes 30–60 seconds.

## If sanctions screening times out partway through a payment
The payment is **held, never sent**. One transaction reserves the funds and saves the payment as `screening`. Screening then runs with a 5-second deadline, and a second transaction applies the result. A timeout or error sets `on_hold`, and the customer sees only "On hold". If the server crashes midway, a sweeper moves the payment to `on_hold`. Releasing it requires a passing re-screen.

**Why:** a timeout means we have no evidence either way. Paying a sanctioned party is illegal and can't be undone; a delay can be. Holding rather than refusing avoids penalising customers for our outage and keeps a human in the loop.
