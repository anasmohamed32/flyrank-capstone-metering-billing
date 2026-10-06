# 🤖 BUILDLOG.md — AI-Assisted Engineering Log
## Capstone: Usage Metering & Billing Engine

This log documents architectural decisions, prompt strategies, areas where AI was helpful, corrections applied, and manual engineering refinements across all build phases.

---

## 1. Phase 1 — Design & Database Architecture
- **Where AI helped**: Scaffolding relational tables for tenants, plans, subscriptions, usage events, and invoices.
- **Where AI needed correction**: The initial model suggested storing costs as floating-point numbers (`REAL`). Corrected to strictly use integer cents for subscription fees and integer micro-units (`1 USD = 1,000,000 micros`) for granular token pricing to eliminate IEEE-754 precision errors.
- **What was manually customized**: Configured foreign key cascade rules, unique indexes on `idempotency_key` and `stripe_subscription_id`, and `WAL` journal mode for high-concurrency SQLite transactions.

---

## 2. Phase 2 — Core Metering & Idempotency Engine
- **Where AI helped**: Writing the `Idempotency-Key` extraction and validation middleware.
- **Where AI needed correction**: Ensuring that duplicate requests bearing the same idempotency key return the cached original response with the `Idempotent-Replay: true` header without re-evaluating quotas or decrementing remaining capacity.
- **What was manually customized**: Implemented atomic lookup & insert inside SQLite transactions to guard against race conditions in distributed or concurrent worker environments.

---

## 3. Phase 3 — Quota Enforcement & Boundary Honesty
- **Where AI helped**: Structuring boundary checks for API calls and AI tokens.
- **Where AI needed correction**: The initial code allowed call 1,001 on a 1,000-call quota because of a `<=` off-by-one error. Refined to strictly verify that `currentUsage + requestedUsage <= quota` so call 1,000 succeeds and call 1,001 returns `429 Too Many Requests`.
- **What was manually customized**: Built automated 80% and 100% threshold alert tracking in `usage_alerts`.

---

## 4. Phase 4 — Stripe Test Mode Integration & Webhook Security
- **Where AI helped**: Writing Stripe Checkout Session creation and webhook handlers for `checkout.session.completed`, `customer.subscription.updated`, and `customer.subscription.deleted`.
- **Where AI needed correction**: Ensuring raw webhook body bytes are preserved prior to JSON parsing for HMAC-SHA256 signature verification.
- **What was manually customized**: Implemented the `webhook_events` deduplication log that safely absorbs duplicate webhook retries without triggering double plan mutations.

---

## 5. Phase 5 — Complex AI Token Money Math
- **Where AI helped**: Formulating token calculation helper functions.
- **Where AI needed correction**: The initial formula lumped reasoning tokens with input tokens. Corrected to count reasoning tokens at the full output token rate (\$10.00/1M) and apply the 50% discount strictly to cached input tokens (\$1.25/1M).
- **What was manually customized**: Implemented itemized invoice generation and subscription reconciliation jobs (`reconcileSubscriptions()`).

---

## 6. Phase 6 — Automated Acceptance Test Suite
- **Where AI helped**: Automating HTTP test requests for the 5 core acceptance probes.
- **Where AI needed correction**: Fixed SQL literal string quoting and dynamic test port assignment to avoid port conflicts.
- **What was manually customized**: Verified that 100% of acceptance probes pass cleanly in under 2 seconds.
