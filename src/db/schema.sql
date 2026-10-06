-- ============================================================================
-- FlyRank Usage Metering & Billing Engine Relational Database Schema
-- Strict Constraints, Integer Money Math (Cents & Micros), Multi-Tenant Isolation
-- ============================================================================

PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

-- 1. Tenants (SaaS Customers)
CREATE TABLE IF NOT EXISTS tenants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  stripe_customer_id TEXT UNIQUE,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'delinquent')),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 2. Subscription Plans & Quotas
CREATE TABLE IF NOT EXISTS plans (
  id TEXT PRIMARY KEY, -- 'free', 'pro', 'enterprise'
  name TEXT NOT NULL,
  monthly_price_cents INTEGER NOT NULL DEFAULT 0, -- Stored as integer cents ($0 = 0, $49 = 4900)
  quota_api_calls INTEGER NOT NULL, -- Free: 1,000; Pro: 100,000
  quota_ai_tokens INTEGER NOT NULL, -- Free: 100,000; Pro: 10,000,000
  overage_rate_api_call_micros INTEGER DEFAULT 1000, -- $0.001 per extra API call = 1,000 micros
  stripe_price_id TEXT,
  features TEXT DEFAULT '[]',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 3. Tenant Subscriptions (Mirrored from Stripe Truth)
CREATE TABLE IF NOT EXISTS subscriptions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL UNIQUE,
  plan_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'past_due', 'canceled', 'trialing', 'incomplete')),
  stripe_subscription_id TEXT UNIQUE,
  current_period_start DATETIME NOT NULL,
  current_period_end DATETIME NOT NULL,
  cancel_at_period_end INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  FOREIGN KEY (plan_id) REFERENCES plans(id)
);

-- 4. Metered Usage Events (Idempotency Key Guaranteed Exactly-Once Recording)
CREATE TABLE IF NOT EXISTS usage_events (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  idempotency_key TEXT UNIQUE NOT NULL, -- Core non-negotiable guarantee!
  event_type TEXT NOT NULL CHECK (event_type IN ('api_call', 'ai_generation', 'batch_job')),
  api_calls INTEGER NOT NULL DEFAULT 1,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  cached_input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens INTEGER NOT NULL DEFAULT 0,
  calculated_cost_micros INTEGER NOT NULL DEFAULT 0, -- Stored as integer micro-cents (1 USD = 1,000,000 micros)
  metadata TEXT DEFAULT '{}',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);

-- 5. Webhook Events (Idempotent Stripe Webhook Ingestion & Signature Log)
CREATE TABLE IF NOT EXISTS webhook_events (
  id TEXT PRIMARY KEY, -- Stripe event id e.g. evt_12345
  event_type TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'processed' CHECK (status IN ('processed', 'ignored_duplicate', 'failed')),
  error_message TEXT,
  processed_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 6. Generated Itemized Invoices (Monthly Statements with Usage Rollups)
CREATE TABLE IF NOT EXISTS invoices (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  period_start DATETIME NOT NULL,
  period_end DATETIME NOT NULL,
  plan_fee_cents INTEGER NOT NULL DEFAULT 0,
  overage_fee_cents INTEGER NOT NULL DEFAULT 0,
  ai_token_cost_cents INTEGER NOT NULL DEFAULT 0,
  total_cents INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'paid' CHECK (status IN ('draft', 'open', 'paid', 'uncollectible')),
  line_items TEXT NOT NULL DEFAULT '[]', -- JSON array of line items
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);

-- 7. Usage Alert Triggers (80% and 100% Quota Thresholds)
CREATE TABLE IF NOT EXISTS usage_alerts (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  metric TEXT NOT NULL CHECK (metric IN ('api_calls', 'ai_tokens')),
  threshold_pct INTEGER NOT NULL CHECK (threshold_pct IN (80, 100, 120)),
  current_usage INTEGER NOT NULL,
  quota_limit INTEGER NOT NULL,
  fired_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
);

-- Indexes for Fast Tenant Lookup, Metering Rollups & Quota Checks
CREATE INDEX IF NOT EXISTS idx_usage_tenant_period ON usage_events(tenant_id, created_at);
CREATE INDEX IF NOT EXISTS idx_usage_idempotency ON usage_events(idempotency_key);
CREATE INDEX IF NOT EXISTS idx_sub_tenant ON subscriptions(tenant_id);
CREATE INDEX IF NOT EXISTS idx_invoices_tenant ON invoices(tenant_id);
CREATE INDEX IF NOT EXISTS idx_alerts_tenant ON usage_alerts(tenant_id);
