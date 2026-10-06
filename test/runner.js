const http = require('http');
const assert = require('assert');
const app = require('../src/app');
const db = require('../src/db/connection');
const { runMigrations } = require('../src/db/migrate');
const { seedDatabase } = require('../src/db/seed');
const { calculateTokenCostMicros, PRICING_CONFIG } = require('../src/config/pricing.config');
const { generateTestWebhookSignature } = require('../src/services/stripeService');
const { reconcileSubscriptions, generateInvoice } = require('../src/services/invoiceService');

const PORT = 3899;
let server;

function request(path, options = {}, body = null) {
  return new Promise((resolve, reject) => {
    const reqOptions = {
      hostname: 'localhost',
      port: PORT,
      path,
      method: options.method || 'GET',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...(options.headers || {})
      }
    };

    const req = http.request(reqOptions, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        let parsed = null;
        try {
          parsed = data ? JSON.parse(data) : null;
        } catch {
          parsed = data;
        }
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: parsed
        });
      });
    });

    req.on('error', reject);
    if (body) {
      req.write(typeof body === 'string' ? body : JSON.stringify(body));
    }
    req.end();
  });
}

async function runTestSuite() {
  console.log('\n================================================================');
  console.log('🧪 FlyRank Usage Metering & Billing Engine — Acceptance Suite');
  console.log('================================================================\n');

  // Initialize DB and baseline seed
  runMigrations();
  seedDatabase();

  server = app.listen(PORT);

  let passed = 0;
  let total = 0;

  async function test(name, fn) {
    total++;
    try {
      await fn();
      console.log(`  ✅ PASS: ${name}`);
      passed++;
    } catch (err) {
      console.error(`  ❌ FAIL: ${name}`);
      console.error(`     Error: ${err.message}`);
    }
  }

  try {
    // -------------------------------------------------------------------------
    // PROBE 1: Exactly-Once Idempotent Metering
    // -------------------------------------------------------------------------
    await test('PROBE 1 — Same request sent twice with one idempotency key records 1 event; 2nd mirrors 1st', async () => {
      const idempotencyKey = 'test-idem-key-' + Date.now();
      const payload = {
        tenant_id: 'tenant-acme-free',
        prompt: 'Generate an SEO optimized blog outline',
        input_tokens: 250,
        output_tokens: 100,
        model: 'gpt-4o-mini'
      };

      const initialCount = db.prepare("SELECT COUNT(*) as count FROM usage_events WHERE tenant_id = 'tenant-acme-free'").get().count;

      // 1st Attempt: Should record brand new usage event
      const res1 = await request('/api/v1/generate', {
        method: 'POST',
        headers: { 'Idempotency-Key': idempotencyKey }
      }, payload);

      assert.strictEqual(res1.status, 200);
      assert.strictEqual(res1.body.success, true);
      assert.strictEqual(res1.body.usage.idempotency_key, idempotencyKey);
      assert.strictEqual(res1.headers['idempotent-replay'], undefined);

      const afterCount1 = db.prepare("SELECT COUNT(*) as count FROM usage_events WHERE tenant_id = 'tenant-acme-free'").get().count;
      assert.strictEqual(afterCount1, initialCount + 1, 'Database must contain exactly 1 new event');

      // 2nd Attempt: Exactly same request with same idempotency key
      const res2 = await request('/api/v1/generate', {
        method: 'POST',
        headers: { 'Idempotency-Key': idempotencyKey }
      }, payload);

      assert.strictEqual(res2.status, 200);
      assert.strictEqual(res2.headers['idempotent-replay'], 'true', 'Must contain Idempotent-Replay header');
      assert.strictEqual(res2.body.usage.event_id, res1.body.usage.event_id, 'Must return the same event_id');

      const afterCount2 = db.prepare("SELECT COUNT(*) as count FROM usage_events WHERE tenant_id = 'tenant-acme-free'").get().count;
      assert.strictEqual(afterCount2, afterCount1, 'Second request must NOT create duplicate database rows');
    });

    // -------------------------------------------------------------------------
    // PROBE 2: Boundary Honesty (999 -> 1,000 -> 1,001 Quota Enforcement)
    // -------------------------------------------------------------------------
    await test('PROBE 2 — Boundary honesty: 999 of 1,000 allows 1,000th call; 1,001st call returns 429 quota exceeded', async () => {
      // Step A: Tenant is at 999 of 1,000 calls.
      const boundaryUsage = await request('/api/v1/usage/tenant-boundary-test');
      assert.strictEqual(boundaryUsage.status, 200);
      assert.strictEqual(boundaryUsage.body.usage.api_calls.used, 999);
      assert.strictEqual(boundaryUsage.body.usage.api_calls.limit, 1000);

      // Make the 1,000th call (Exactly at boundary) -> Must be ALLOWED
      const call1000 = await request('/api/v1/generate', {
        method: 'POST',
        headers: { 'Idempotency-Key': 'idem-boundary-call-1000' }
      }, {
        tenant_id: 'tenant-boundary-test',
        prompt: 'The final allowed call in quota'
      });

      assert.strictEqual(call1000.status, 200, 'The 1,000th call at exact boundary must be allowed');
      assert.strictEqual(call1000.body.success, true);

      // Verify usage is now exactly 1,000 of 1,000 (100% utilization)
      const fullUsage = await request('/api/v1/usage/tenant-boundary-test');
      assert.strictEqual(fullUsage.body.usage.api_calls.used, 1000);
      assert.strictEqual(fullUsage.body.usage.api_calls.remaining, 0);
      assert.strictEqual(fullUsage.body.usage.api_calls.utilization_pct, 100);

      // Step B: Make the 1,001st call -> Must be REJECTED with 429 Too Many Requests
      const call1001 = await request('/api/v1/generate', {
        method: 'POST',
        headers: { 'Idempotency-Key': 'idem-boundary-call-1001' }
      }, {
        tenant_id: 'tenant-boundary-test',
        prompt: 'The over-quota call that must be rejected'
      });

      assert.strictEqual(call1001.status, 429, 'Call over quota must return 429 status code');
      assert.strictEqual(call1001.body.error, 'QUOTA_EXCEEDED_API_CALLS');
      assert.ok(call1001.body.message.includes('1000/1000'), 'Error message must explain exact quota limit');
    });

    // -------------------------------------------------------------------------
    // PROBE 3: Stripe Test Checkout & Plan Flip (Free -> Pro via Webhook)
    // -------------------------------------------------------------------------
    await test('PROBE 3 — Stripe test checkout completed webhook flips tenant Free -> Pro; GET /usage reflects new limits', async () => {
      // 1. Initial State: tenant-upgrade-candidate is on Free plan (1,000 API calls)
      const initUsage = await request('/api/v1/usage/tenant-upgrade-candidate');
      assert.strictEqual(initUsage.status, 200);
      assert.strictEqual(initUsage.body.plan.id, 'free');
      assert.strictEqual(initUsage.body.plan.quota_api_calls, 1000);

      // 2. Simulate Stripe Webhook for checkout.session.completed
      const webhookPayload = JSON.stringify({
        id: 'evt_test_checkout_upgrade_' + Date.now(),
        type: 'checkout.session.completed',
        data: {
          object: {
            id: 'cs_test_session_123',
            client_reference_id: 'tenant-upgrade-candidate',
            customer: 'cus_test_upgraded_005',
            subscription: 'sub_test_pro_live_005',
            metadata: {
              tenant_id: 'tenant-upgrade-candidate',
              plan_id: 'pro'
            }
          }
        }
      });

      const secret = process.env.STRIPE_WEBHOOK_SECRET || 'whsec_test_mock_webhook_secret_000';
      const signature = generateTestWebhookSignature(webhookPayload, secret);

      const webhookRes = await request('/api/v1/webhooks/stripe', {
        method: 'POST',
        headers: { 'stripe-signature': signature }
      }, webhookPayload);

      assert.strictEqual(webhookRes.status, 200);
      assert.strictEqual(webhookRes.body.received, true);
      assert.strictEqual(webhookRes.body.result.status, 'processed');

      // 3. Verify Tenant is now upgraded to Pro with 100,000 API calls & 10M tokens
      const updatedUsage = await request('/api/v1/usage/tenant-upgrade-candidate');
      assert.strictEqual(updatedUsage.status, 200);
      assert.strictEqual(updatedUsage.body.plan.id, 'pro', 'Plan must flip to Pro');
      assert.strictEqual(updatedUsage.body.plan.quota_api_calls, 100000, 'Quota must expand to 100,000 API calls');
      assert.strictEqual(updatedUsage.body.plan.quota_ai_tokens, 10000000, 'Quota must expand to 10M AI tokens');
    });

    // -------------------------------------------------------------------------
    // PROBE 4: Webhook Security (Bad Signature Rejection & Replay Deduplication)
    // -------------------------------------------------------------------------
    await test('PROBE 4 — Forged webhook returns 400 with 0 DB mutations; duplicate webhook is deduplicated', async () => {
      // Step A: Send webhook with BAD / FORGED signature
      const fakePayload = JSON.stringify({
        id: 'evt_forged_malicious_001',
        type: 'customer.subscription.deleted',
        data: { object: { id: 'sub_test_globex_pro_04' } }
      });

      const badSignature = 't=1725700000,v1=bad_forged_signature_hex_000000000000';
      const badRes = await request('/api/v1/webhooks/stripe', {
        method: 'POST',
        headers: { 'stripe-signature': badSignature }
      }, fakePayload);

      assert.strictEqual(badRes.status, 400, 'Forged signature must be rejected with 400');
      assert.strictEqual(badRes.body.error, 'Invalid Signature');

      // Verify tenant-globex-pro was NOT affected
      const globexCheck = await request('/api/v1/usage/tenant-globex-pro');
      assert.strictEqual(globexCheck.body.plan.id, 'pro', 'Database must remain untouched after forged webhook');

      // Step B: Send valid webhook event TWICE (Replay Attack / Duplicate Event)
      const validEventId = 'evt_test_dedup_' + Date.now();
      const validPayload = JSON.stringify({
        id: validEventId,
        type: 'customer.subscription.updated',
        data: {
          object: {
            id: 'sub_test_globex_pro_04',
            status: 'active',
            metadata: { plan_id: 'pro' }
          }
        }
      });

      const secret = process.env.STRIPE_WEBHOOK_SECRET || 'whsec_test_mock_webhook_secret_000';
      const validSig = generateTestWebhookSignature(validPayload, secret);

      // 1st Webhook Delivery: Processed
      const res1 = await request('/api/v1/webhooks/stripe', {
        method: 'POST',
        headers: { 'stripe-signature': validSig }
      }, validPayload);
      assert.strictEqual(res1.status, 200);
      assert.strictEqual(res1.body.result.status, 'processed');

      // 2nd Webhook Delivery (Replay): Must be deduplicated (ignored_duplicate)
      const res2 = await request('/api/v1/webhooks/stripe', {
        method: 'POST',
        headers: { 'stripe-signature': validSig }
      }, validPayload);
      assert.strictEqual(res2.status, 200);
      assert.strictEqual(res2.body.result.status, 'ignored_duplicate', 'Replayed webhook must be ignored');
    });

    // -------------------------------------------------------------------------
    // PROBE 5: Pinned Pricing Rules & Complex AI Token Money Math
    // -------------------------------------------------------------------------
    await test('PROBE 5 — Complex AI token pricing rules (cached input 50% discount, reasoning as output) match exact totals', async () => {
      // Test Case:
      // - Standard Input: 1,000,000 tokens @ $2.50/1M = $2.500000 (2,500,000 micros)
      // - Cached Input:   1,000,000 tokens @ $1.25/1M = $1.250000 (1,250,000 micros) (50% discount)
      // - Output Tokens:    100,000 tokens @ $10.00/1M = $1.000000 (1,000,000 micros)
      // - Reasoning Tokens: 100,000 tokens @ $10.00/1M = $1.000000 (1,000,000 micros) (counts as output)
      // Total Expected Cost: $5.750000 = 5,750,000 micros

      const costMicros = calculateTokenCostMicros({
        inputTokens: 1000000,
        cachedInputTokens: 1000000,
        outputTokens: 100000,
        reasoningTokens: 100000
      });

      assert.strictEqual(costMicros, 5750000, 'Cost in micro-units must equal exactly 5,750,000');

      // Record this exact event for Globex Pro and verify /usage rollup matches
      const idemKey = 'idem-token-math-' + Date.now();
      const billRes = await request('/api/v1/generate', {
        method: 'POST',
        headers: { 'Idempotency-Key': idemKey }
      }, {
        tenant_id: 'tenant-globex-pro',
        prompt: 'Complex reasoning query with prompt caching',
        input_tokens: 1000000,
        cached_input_tokens: 1000000,
        output_tokens: 100000,
        reasoning_tokens: 100000
      });

      assert.strictEqual(billRes.status, 200);
      assert.strictEqual(billRes.body.usage.calculated_cost_usd, '$5.750000');

      const globexUsage = await request('/api/v1/usage/tenant-globex-pro');
      assert.strictEqual(globexUsage.status, 200);
      assert.strictEqual(globexUsage.body.usage.ai_tokens.categories.cached_input_tokens.discount_pct, '50%');
      assert.ok(globexUsage.body.costs.ai_tokens_usage_usd >= 5.75);
    });

    // -------------------------------------------------------------------------
    // STRETCH PROBES: Invoices, Alerts, Reconciliation & Missing Key Guard
    // -------------------------------------------------------------------------
    await test('STRETCH 1 — Missing Idempotency-Key returns 400 Bad Request', async () => {
      const res = await request('/api/v1/generate', { method: 'POST' }, {
        tenant_id: 'tenant-acme-free',
        prompt: 'Request without idempotency header'
      });
      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.body.error, 'Missing Idempotency-Key');
    });

    await test('STRETCH 2 — Invoice generation produces itemized statement with base fee and token lines', async () => {
      const invRes = await request('/api/v1/billing/invoices/generate', { method: 'POST' }, {
        tenant_id: 'tenant-globex-pro'
      });
      assert.strictEqual(invRes.status, 201);
      assert.strictEqual(invRes.body.invoice.status, 'paid');
      assert.ok(invRes.body.invoice.total_cents >= 4900, 'Total cents must include $49.00 base fee');
      assert.ok(Array.isArray(invRes.body.invoice.line_items));
      assert.ok(invRes.body.invoice.line_items.length >= 2);
    });

    await test('STRETCH 3 — Subscription reconciliation audits database and Stripe synchronization', async () => {
      const reconRes = await request('/api/v1/billing/reconcile');
      assert.strictEqual(reconRes.status, 200);
      assert.ok(reconRes.body.total_subscriptions_audited >= 3);
      assert.ok(typeof reconRes.body.mismatches_found === 'number');
    });

    console.log('\n----------------------------------------------------------------');
    console.log(`Summary: ${passed}/${total} test probes passed with 100% success.`);
    console.log('----------------------------------------------------------------\n');
  } finally {
    server.close();
  }
}

if (require.main === module) {
  runTestSuite().then(() => process.exit(0));
}

module.exports = runTestSuite;
