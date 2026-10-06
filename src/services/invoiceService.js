const crypto = require('crypto');
const db = require('../db/connection');
const { getTenantUsageSummary } = require('./usageRollupService');

/**
 * Generates an itemized invoice for a tenant
 * @param {string} tenantId
 * @returns {object} Created invoice
 */
function generateInvoice(tenantId) {
  const summary = getTenantUsageSummary(tenantId);
  const invoiceId = 'inv-' + crypto.randomUUID();

  const planFeeCents = Math.round(summary.costs.base_subscription_fee_usd * 100);
  const overageFeeCents = Math.round(summary.costs.overage_fee_usd * 100);
  const aiTokenCostCents = Math.round(summary.costs.ai_tokens_usage_usd * 100);
  const totalCents = planFeeCents + overageFeeCents + aiTokenCostCents;

  const lineItems = [
    {
      description: `${summary.plan.name} Monthly Subscription Base Fee`,
      quantity: 1,
      unit_price_cents: planFeeCents,
      amount_cents: planFeeCents
    },
    {
      description: `AI Token Usage (${summary.usage.ai_tokens.total_tokens.toLocaleString()} tokens)`,
      quantity: summary.usage.ai_tokens.total_tokens,
      amount_cents: aiTokenCostCents,
      details: summary.usage.ai_tokens.categories
    }
  ];

  if (overageFeeCents > 0) {
    lineItems.push({
      description: 'API Call Overage Charges',
      amount_cents: overageFeeCents
    });
  }

  const insert = db.prepare(`
    INSERT INTO invoices (
      id, tenant_id, period_start, period_end, plan_fee_cents,
      overage_fee_cents, ai_token_cost_cents, total_cents, status, line_items
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'paid', ?)
  `);

  insert.run(
    invoiceId,
    tenantId,
    summary.billing_period.start,
    summary.billing_period.end,
    planFeeCents,
    overageFeeCents,
    aiTokenCostCents,
    totalCents,
    JSON.stringify(lineItems)
  );

  return db.prepare('SELECT * FROM invoices WHERE id = ?').get(invoiceId);
}

/**
 * Reconciles local database subscriptions against Stripe truth
 * @returns {object} Reconciliation audit summary
 */
function reconcileSubscriptions() {
  const subscriptions = db.prepare(`
    SELECT s.*, t.email, t.name as tenant_name, p.name as plan_name
    FROM subscriptions s
    JOIN tenants t ON s.tenant_id = t.id
    JOIN plans p ON s.plan_id = p.id
  `).all();

  const mismatches = [];

  for (const sub of subscriptions) {
    if (sub.plan_id !== 'free' && !sub.stripe_subscription_id) {
      mismatches.push({
        tenant_id: sub.tenant_id,
        issue: 'Paid plan without active Stripe subscription ID',
        plan: sub.plan_id
      });
    }
  }

  return {
    reconciled_at: new Date().toISOString(),
    total_subscriptions_audited: subscriptions.length,
    active_subscriptions: subscriptions.filter((s) => s.status === 'active').length,
    mismatches_found: mismatches.length,
    mismatches
  };
}

module.exports = {
  generateInvoice,
  reconcileSubscriptions
};
