# 🏛️ Architecture & System Design Document
## Usage Metering & Billing Engine (`flyrank-capstone-metering-billing`)

---

## 1. Problem Statement & Mission

Every SaaS system on Earth must reliably answer three fundamental questions:
1. **How much has this customer used?**
2. **What does it cost under complex pricing rules?**
3. **Have they reached their plan quota limit?**

In billing, bugs directly cost real money: a network retry that double-counts usage, an off-by-one error at the 999 vs 1,000 quota boundary, or an unverified webhook replay that creates phantom upgrades.

This platform implements an **Idempotent Usage Metering & Billing Engine** featuring:
- **Exactly-Once Metering**: Deterministic deduplication using `Idempotency-Key` headers on all billable endpoints.
- **Boundary Honesty**: Strict quota enforcement with human-readable and machine-readable `429 Too Many Requests` and `402 Payment Required` errors.
- **Complex AI Token Money Math**: Pinned pricing rules with integer micro-unit storage (cached input tokens @ 50% discount, reasoning tokens counted as output).
- **Stripe Test Mode Webhooks**: Signature verification (`stripe-signature` with HMAC-SHA256), replay event deduplication, and automatic tenant plan synchronization (Free $\rightarrow$ Pro).

---

## 2. Architecture & Pipeline

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

## 3. Data Model & Database Schema

The database uses relational SQLite with strict foreign keys and indexed lookups:

- `tenants`: SaaS customers (`id`, `name`, `email`, `stripe_customer_id`, `status`).
- `plans`: Quotas and pricing tiers (`free`, `pro`, `enterprise`).
- `subscriptions`: Active plan tracking (`current_period_start`, `current_period_end`, `stripe_subscription_id`).
- `usage_events`: Metered events with `idempotency_key UNIQUE`, token breakdowns, and integer `calculated_cost_micros`.
- `webhook_events`: Stripe event deduplication log (`id UNIQUE`, `event_type`, `status`).
- `invoices`: Itemized monthly statements with base fee, overages, and token usage line items.
- `usage_alerts`: Threshold notifications (80%, 100%).

---

## 4. Plans & Quotas

| Plan ID | Monthly Fee | API Calls Quota | AI Tokens Quota | Overage Rate | Target Audience |
|---|---|---|---|---|---|
| `free` | \$0.00 / mo | 1,000 / month | 100,000 / month | None (Hard Limit) | Developers & Evaluation |
| `pro` | \$49.00 / mo | 100,000 / month | 10,000,000 / month | \$0.0005 / call | High-volume SaaS Teams |
| `enterprise` | \$299.00 / mo | 1,000,000 / month | 100,000,000 / month | Custom SLA | Dedicated Infrastructure |

---

## 5. Token Pricing Rules & Money Math

- **Standard Input Tokens**: \$2.50 per 1,000,000 tokens (\$0.0000025 / token = 2.5 micro-units).
- **Cached Input Tokens**: \$1.25 per 1,000,000 tokens (50% discount = 1.25 micro-units).
- **Output Tokens**: \$10.00 per 1,000,000 tokens (\$0.000010 / token = 10.0 micro-units).
- **Reasoning Tokens**: Counted at output token rate (\$10.00 per 1M tokens = 10.0 micro-units).
- All money math is calculated in integer micro-units ($1\text{ USD} = 1,000,000\text{ micros}$) and cents ($1\text{ USD} = 100\text{ cents}$).

---

## 6. Explicit Non-Goals

1. **No Real Credit Card Charges**: Operates 100% within Stripe test mode (`4242...` card simulation).
2. **No External Infrastructure Dependencies**: Runs out of the box with zero cloud fees.
3. **No Floating-Point Money Calculations**: Money calculations never use standard raw floats for currency storage.
