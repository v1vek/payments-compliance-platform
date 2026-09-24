# Meridian: submission notes

## What I built
A small working version of the platform, with four parts:
- a **customer screen** for sending payments
- a **compliance screen** for reviewing held payments
- a **Node/TypeScript backend** that holds every rule
- a **PostgreSQL database**

The browser never talks to the database directly and never makes a decision on its own. Every check happens on the server.

## Assumptions
Where the brief didn't say, this is what I decided.

### The sanctions list
- The five names are fictional and stored in a database table. The app can read the list but can't change it.
- A name matches if it's the same name with a different spelling, a typo, or the words in a different order. For example, "Victor Orlanoff" matches "Viktor Orlanov", and "Karim Zaehdi" matches "Karim Zahedi".
- How it works: both names are cleaned up first. That means lowercase, no accents or punctuation, company words like "Ltd" removed, and similar-sounding letters (c/k, v/w/f) treated as the same. Then the two names are compared letter by letter. If they're at least 85% the same, it's a match.
- A surname or initials on their own ("Orlanov", "V. Orlanov") don't count. Matching those would block too many innocent people.

### The $8,000 review threshold
- I add up everything the customer has sent in the last 7 days, including the new payment. If the total reaches $8,000, the new payment is held for review.
- Payments that were sent, are on hold, or are still processing count towards the total. Refused and rejected payments don't, because no money left the account.
- In the demo, $2,000 + $7,500 = $9,500, so the $7,500 payment is held even though it's under $8,000 on its own.

### What happens to a payment
- The checks run in this order: basic validation, set the money aside, sanctions check, threshold check, send.
- The customer only ever sees one of four statuses: **Processing**, **Sent**, **On hold** or **Cannot be processed**. They're never told why.
- The money is set aside as soon as a payment is submitted, so it can't be spent twice. It only leaves the account when the payment is sent, and it goes back if the payment is refused or rejected.

### Compliance review
- Either officer can make the first recommendation (release or reject). A **different** officer must make the final decision, and they're allowed to disagree with the recommendation.
- Before any held payment is released, the name is checked against the sanctions list again, in case the list changed while the payment was waiting.

### History and money
- Every action is written to a history that can't be edited or deleted. That includes payments, checks, decisions, sign-ins and blocked attempts. The app has no permission to change it, and a database rule blocks changes even from the database owner.
- Amounts are stored as whole cents. $2,000 is stored as 200000. Decimals are never used for money.

### For the demo
- Any recipient name containing "Timeout Test" pretends the sanctions service is down, so you can see what happens when it fails.
- "Reset demo data" on the sign-in page gives the customer a fresh account without deleting any history.

## What's not finished
- US dollars only. No currency conversion, fees, or connection to real banks.
- The sanctions check uses a stand-in service instead of a real provider, and there's no screen for managing the list.
- No two-factor sign-in or password reset.
- The demo runs on free hosting. If nobody has used it for 15 minutes, the first page load takes 30–60 seconds while the server wakes up.

## If the sanctions check times out partway through a payment
**The payment is held. It is never sent.**

Step by step:
1. The money is set aside and the payment is saved as "processing".
2. The sanctions service is called. If it doesn't answer within 5 seconds, or returns an error, the payment is put on hold.
3. The customer just sees "On hold". The compliance team sees that the check timed out.
4. If the server crashes partway through, a background job finds any payment stuck in "processing" and puts it on hold as well.
5. When an officer releases the payment, the sanctions check runs again and has to pass before any money moves. If the service is still down, the payment stays on hold.

**Why:** a timeout tells us nothing about whether the person is sanctioned. Sending money to a sanctioned person is illegal and can't be undone, while a short delay is easy to fix. Holding the payment instead of refusing it is fairer to the customer, because the problem was on our side. It also means a person makes the final call.
