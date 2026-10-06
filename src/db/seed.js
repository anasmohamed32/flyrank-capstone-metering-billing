const db = require('./connection');
const { runMigrations } = require('./migrate');

function seedDatabase() {
  console.log('🌱 [DB Seed] Initializing database with plans and baseline test tenants...');

  runMigrations();

  const insertPlan = db.prepare(`
    INSERT OR REPLACE INTO plans (
      id, name, monthly_price_cents, quota_api_calls, quota_ai_tokens, overage_rate_api_call_micros, stripe_price_id, features
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertTenant = db.prepare(`
    INSERT OR REPLACE INTO tenants (
      id, name, email, stripe_customer_id, status
    ) VALUES (?, ?, ?, ?, ?)
  `);

  const insertSubscription = db.prepare(`
    INSERT OR REPLACE INTO subscriptions (
      id, tenant_id, plan_id, status, stripe_subscription_id, current_period_start, current_period_end
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const insertUsage = db.prepare(`
    INSERT OR REPLACE INTO usage_events (
      id, tenant_id, idempotency_key, event_type, api_calls, input_tokens, cached_input_tokens,
      output_tokens, reasoning_tokens, calculated_cost_micros, metadata, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const now = new Date();
  const periodStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  const periodEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1).toISOString();

  db.transaction(() => {
    // 1. Seed Plans
    insertPlan.run(
      'free',
      'Free Developer Plan',
      0, // $0
      1000, // 1,000 API calls / mo
      100000, // 100k AI tokens / mo
      1000, // $0.001 per extra call
      'price_test_free_tier',
      JSON.stringify(['Community Support', 'Basic Rate Limiting', '1,000 API Calls', '100k AI Tokens'])
    );

    insertPlan.run(
      'pro',
      'Pro Scaling Plan',
      4900, // $49.00 / mo
      100000, // 100,000 API calls / mo
      10000000, // 10M AI tokens / mo
      500, // $0.0005 per extra call
      'price_test_pro_monthly',
      JSON.stringify(['Priority Support', 'High Throughput', '100k API Calls', '10M AI Tokens', 'Overage Protection'])
    );

    insertPlan.run(
      'enterprise',
      'Enterprise Dedicated Plan',
      29900, // $299.00 / mo
      1000000, // 1,000,000 API calls / mo
      100000000, // 100M AI tokens / mo
      200,
      'price_test_enterprise_monthly',
      JSON.stringify(['Dedicated Account Manager', 'Custom SLA', '1M API Calls', '100M AI Tokens'])
    );

    // 2. Seed Tenants
    // Tenant 1: Acme Labs (Standard Free Tenant with some usage)
    insertTenant.run('tenant-acme-free', 'Acme Labs', 'billing@acme.dev', 'cus_test_acme_001', 'active');
    insertSubscription.run('sub-acme-01', 'tenant-acme-free', 'free', 'active', 'sub_test_acme_free_01', periodStart, periodEnd);

    // Seed some initial usage for Acme Labs
    insertUsage.run(
      'evt-seed-acme-01',
      'tenant-acme-free',
      'seed-idem-acme-01',
      'api_call',
      450, // 450 calls
      50000, // 50k input
      20000, // 20k cached input
      15000, // 15k output
      5000, // 5k reasoning
      120000, // micro cost
      JSON.stringify({ note: 'Initial seed batch usage' }),
      new Date(Date.now() - 3600000 * 24 * 2).toISOString()
    );

    // Tenant 2: Boundary Test Tenant (At 999 of 1,000 calls for Probe 2)
    insertTenant.run('tenant-boundary-test', 'Boundary Prober Co', 'dev@boundary.test', 'cus_test_boundary_002', 'active');
    insertSubscription.run('sub-boundary-01', 'tenant-boundary-test', 'free', 'active', 'sub_test_boundary_02', periodStart, periodEnd);
    insertUsage.run(
      'evt-seed-boundary-999',
      'tenant-boundary-test',
      'seed-idem-boundary-999',
      'api_call',
      999, // Exactly 999 of 1,000 calls
      20000,
      0,
      5000,
      0,
      50000,
      JSON.stringify({ note: 'Positioned at 999 boundary limit' }),
      new Date(Date.now() - 3600000 * 12).toISOString()
    );

    // Tenant 3: Exceeded Quota Tenant (At 1,000 of 1,000 calls - Next call must fail with 429/402)
    insertTenant.run('tenant-exceeded-test', 'Exceeded Quota Inc', 'ops@exceeded.test', 'cus_test_exceeded_003', 'active');
    insertSubscription.run('sub-exceeded-01', 'tenant-exceeded-test', 'free', 'active', 'sub_test_exceeded_03', periodStart, periodEnd);
    insertUsage.run(
      'evt-seed-exceeded-1000',
      'tenant-exceeded-test',
      'seed-idem-exceeded-1000',
      'api_call',
      1000, // Exactly 1,000 of 1,000 calls
      100000,
      0,
      25000,
      0,
      150000,
      JSON.stringify({ note: 'Positioned at 1,000 exhausted quota' }),
      new Date(Date.now() - 3600000 * 6).toISOString()
    );

    // Tenant 4: Globex Pro (Active Pro Tenant with high limits)
    insertTenant.run('tenant-globex-pro', 'Globex Corporation', 'finance@globex.corp', 'cus_test_globex_004', 'active');
    insertSubscription.run('sub-globex-01', 'tenant-globex-pro', 'pro', 'active', 'sub_test_globex_pro_04', periodStart, periodEnd);
    insertUsage.run(
      'evt-seed-globex-01',
      'tenant-globex-pro',
      'seed-idem-globex-01',
      'ai_generation',
      5000,
      1200000,
      400000,
      350000,
      100000,
      2850000,
      JSON.stringify({ model: 'gpt-4o-enterprise' }),
      new Date(Date.now() - 3600000 * 24).toISOString()
    );

    // Tenant 5: Upgrade Candidate (Free tenant that will be upgraded to Pro in Stripe Webhook tests)
    insertTenant.run('tenant-upgrade-candidate', 'SaaS Startup Labs', 'founder@startuplabs.io', 'cus_test_upgrade_005', 'active');
    insertSubscription.run('sub-upgrade-01', 'tenant-upgrade-candidate', 'free', 'active', 'sub_test_upgrade_init_05', periodStart, periodEnd);
  })();

  console.log('✨ [DB Seed] Seed completed successfully with 3 plans and 5 isolated tenants.');
}

if (require.main === module) {
  seedDatabase();
}

module.exports = { seedDatabase };
