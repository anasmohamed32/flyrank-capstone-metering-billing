# ⚡ Usage Metering & Billing Engine

> **FlyRank Backend Track Capstone Project**  
> *Build the service every SaaS needs: how much has this customer used, what does it cost, and have they hit their limit? Metering, quotas, correct money math, and Stripe test mode — where correctness really matters.*

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen.svg)](https://nodejs.org/)
[![Acceptance Probes](https://img.shields.io/badge/Acceptance%20Probes-8%2F8%20Passing-brightgreen.svg)]()
[![Free Tools Promise](https://img.shields.io/badge/%240%20Stack-Zero%20Credit%20Card-success.svg)]()

---

## 📖 1. Overview & System Mission

Every SaaS company on Earth must answer three critical questions:
1. **How much has this customer used?**
2. **How much should they pay under complex pricing rules?**
3. **Have they reached their plan limits?**

Billing bugs cost real money: a network retry that double-charges customers, an off-by-one boundary error that gives away unlimited access, or a replayed webhook that corrupts subscription states.

This project delivers a complete **Usage Metering & Billing Engine** built for correctness, resilience, and multi-tenant isolation:
- **Exactly-Once Metering**: Idempotency key deduplication ensures retried requests never double-count usage or charge twice.
- **Boundary Honesty**: Quota enforcement accurately differentiates between call 999, call 1,000, and call 1,001 with explicit `429 Too Many Requests` or `402 Payment Required` errors.
- **Complex AI Token Money Math**: Pinned pricing rules with integer micro-unit storage (cached input tokens @ 50% discount, reasoning tokens counted as output).
- **Stripe Test Mode Integration**: Signature verification, webhook replay deduplication, and automatic Free $\rightarrow$ Pro plan synchronization.
- **Automated Alerts & Invoicing**: Threshold triggers at 80% and 100% of quota and itemized monthly statements.

---

## 🏛️ 2. Architecture & Request Pipeline

```
+========================================================================================================+
|                                    USAGE METERING & BILLING PIPELINE                                   |
+========================================================================================================+

                               [ 1. IDEMPOTENT METERING INGESTION ]
                               
       Billable API Request -----> [ Idempotency Guard (Key Lookup) ]
       (POST /generate)                        |
                                               +---> Duplicate Key? --> Return Cached Event (No New Write)
                                               |
                                               v (New Key)
                                   [ Quota Enforcement Gate ]
                                   (Current Usage + Requested)
                                               |
                         +---------------------+---------------------+
                         |                                           |
                         v (Under Quota)                             v (Quota Exceeded)
              [ Calculate Token Money Math ]                [ 429 Too Many Requests / 402 ]
              (Integer Micro-Units & Cents)                 with detailed diagnostic boundary
                         |
                         v
              [ Store in usage_events Table ]
                         |
                         v
             (80% or 100% threshold crossed? --> Trigger usage_alerts)

----------------------------------------------------------------------------------------------------------

                               [ 2. STRIPE WEBHOOK PAYMENT SYNC ]

       Stripe Event Delivery ----> [ Signature Verification Guard ]
       (POST /webhooks/stripe)                 |
                                               +---> Bad Signature? --> 400 Bad Request (0 DB Changes)
                                               |
                                               v (Valid Signature)
                                   [ Event Deduplication Check ]
                                   (Check webhook_events Table)
                                               |
                         +---------------------+---------------------+
                         |                                           |
                         v (First Time Event)                        v (Replay / Duplicate)
              [ Update Subscriptions Table ]                [ 200 OK: ignored_duplicate ]
              (Flip Tenant Free -> Pro)                     (Zero Duplicate State Mutations)

----------------------------------------------------------------------------------------------------------

                               [ 3. REAL-TIME USAGE & COST ROLLUP ]

       GET /usage/:tenant_id ----> [ Aggregate Usage & Cost Math ] ---> Output Summary, Limits, Alerts
```

---

## 💳 3. Subscription Plans & Token Pricing

### Plans & Quotas

| Plan ID | Monthly Fee | API Calls Quota | AI Tokens Quota | Overage Rate | Target Audience |
|---|---|---|---|---|---|
| `free` | \$0.00 / mo | 1,000 / month | 100,000 / month | None (Hard Limit) | Developers & Evaluation |
| `pro` | \$49.00 / mo | 100,000 / month | 10,000,000 / month | \$0.0005 / call | High-volume SaaS Teams |
| `enterprise` | \$299.00 / mo | 1,000,000 / month | 100,000,000 / month | Custom SLA | Dedicated Infrastructure |

### AI Token Pricing Rules

- **Standard Input Tokens**: \$2.50 per 1M tokens (\$0.0000025 / token = 2.5 micro-units).
- **Cached Input Tokens**: \$1.25 per 1M tokens (50% discount = 1.25 micro-units).
- **Output Tokens**: \$10.00 per 1M tokens (\$0.000010 / token = 10.0 micro-units).
- **Reasoning Tokens**: Counted at output token rate (\$10.00 per 1M tokens = 10.0 micro-units).
- **Zero Float Guarantee**: All money calculations are stored as integer micro-units ($1\text{ USD} = 1,000,000\text{ micros}$) and cents ($1\text{ USD} = 100\text{ cents}$) to eliminate precision rounding errors.

---

## ⚡ 4. Quick Start & Execution

### Prerequisites
- Node.js (v18 or higher)
- npm

### 1. Installation & Environment Setup
```bash
# Clone the repository
git clone https://github.com/HossamSaberr/flyrank-capstone-metering-billing.git
cd flyrank-capstone-metering-billing

# Copy environment variables
cp .env.example .env

# Install dependencies
npm install
```

### 2. Database Migration & Seeding
```bash
npm run seed
```

### 3. Start Application
```bash
npm start
```
Server boots on `http://localhost:3000`.

### 4. Run Automated Test Suite
```bash
npm test
```

---

## 📡 5. API Reference & Contracts

### A. Metering & Billable Endpoint
- `POST /api/v1/generate` (or `/generate`) — Evaluates quota, records metered usage with `Idempotency-Key` header (`200 OK` or `429 Too Many Requests`).
- `POST /api/v1/usage/record` — Directly records a custom usage event with idempotency (`200 OK`).

### B. Usage & Quotas
- `GET /api/v1/usage` (or `/usage`) — Returns usage rollup, quota limits, and token money math (`200 OK`).
- `GET /api/v1/usage/:tenant_id` — Returns usage breakdown for a specific tenant (`200 OK`).
- `GET /api/v1/usage/plans/list` — Lists all available subscription plans (`200 OK`).
- `GET /api/v1/usage/tenants/list` — Lists all registered SaaS tenants (`200 OK`).

### C. Stripe Payments & Webhooks
- `POST /api/v1/billing/checkout` — Creates a Stripe Checkout Session for subscription upgrade (`200 OK`).
- `POST /api/v1/webhooks/stripe` (or `/webhooks/stripe`) — Signature-verified, idempotent Stripe webhook receiver (`200 OK` or `400 Bad Request`).
- `POST /api/v1/billing/invoices/generate` — Generates itemized monthly invoice statement (`201 Created`).
- `GET /api/v1/billing/invoices/:tenant_id` — Lists historical invoices (`200 OK`).
- `GET /api/v1/billing/reconcile` — Audits database subscriptions against Stripe truth (`200 OK`).

---

## 🧪 6. Verified Acceptance Probes

1. **PROBE 1 (Idempotency)**: Retrying a billable request with the same `Idempotency-Key` records exactly 1 event and returns `Idempotent-Replay: true`.
2. **PROBE 2 (Boundary Honesty)**: Tenant at 999 calls succeeds on call 1,000 and is blocked on call 1,001 with `429 Too Many Requests`.
3. **PROBE 3 (Plan Upgrade)**: Stripe `checkout.session.completed` webhook flips tenant Free $\rightarrow$ Pro and expands limits to 100,000 calls & 10M tokens.
4. **PROBE 4 (Webhook Security & Dedup)**: Forged signature returns `400 Bad Request` with 0 DB mutations; duplicate webhooks are deduplicated.
5. **PROBE 5 (Token Money Math)**: Cached input (50% discount) and reasoning tokens (output rate) match exact micro-unit sums.

---

## ⚠️ 7. Honest Limitations & Scope

1. **Stripe Test Mode**: Operates exclusively in Stripe Test Mode using `4242...` simulation; no real credit card numbers or currency transactions are processed.
2. **Simulated AI Tokens**: The billable `/generate` endpoint meters token counts and applies complex pricing rules without making external LLM calls.
3. **Single Region SQLite**: Storage is built on high-speed single-instance SQLite with `WAL` mode; distributed multi-region clustering would require distributed consensus (e.g. Postgres with Raft).

---

## 📄 License
MIT License.
