const db = require('../db/connection');
const { getTenantSubscriptionDetails, getCurrentPeriodUsage } = require('./quotaService');
const { PRICING_CONFIG, microsToUsdString, centsToUsdString } = require('../config/pricing.config');

/**
 * Returns comprehensive usage, limits, and money math breakdown for a tenant
 * @param {string} tenantId
 * @returns {object}
 */
function getTenantUsageSummary(tenantId) {
  const { tenant, subscription, plan } = getTenantSubscriptionDetails(tenantId);

  const now = new Date();
  const periodStart = subscription.current_period_start || new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  const periodEnd = subscription.current_period_end || new Date(now.getFullYear(), now.getMonth() + 1, 1).toISOString();

  const usage = getCurrentPeriodUsage(tenantId, periodStart, periodEnd);

  // Detailed Token Cost Math
  const inputCostMicros = Math.round(usage.tokens.input * PRICING_CONFIG.AI_TOKENS.INPUT_MICROS_PER_TOKEN);
  const cachedCostMicros = Math.round(usage.tokens.cached_input * PRICING_CONFIG.AI_TOKENS.CACHED_INPUT_MICROS_PER_TOKEN);
  const outputCostMicros = Math.round(usage.tokens.output * PRICING_CONFIG.AI_TOKENS.OUTPUT_MICROS_PER_TOKEN);
  const reasoningCostMicros = Math.round(usage.tokens.reasoning * PRICING_CONFIG.AI_TOKENS.REASONING_MICROS_PER_TOKEN);
  const totalTokenCostMicros = inputCostMicros + cachedCostMicros + outputCostMicros + reasoningCostMicros;

  // Overage Math (If usage exceeds quota on paid plans with overage allowed)
  const overageCalls = Math.max(0, usage.api_calls - plan.quota_api_calls);
  const overageCostMicros = overageCalls * plan.overage_rate_api_call_micros;

  const basePlanPriceCents = plan.monthly_price_cents;
  const basePlanPriceUsd = basePlanPriceCents / 100;
  const tokenCostUsd = parseFloat((totalTokenCostMicros / 1000000).toFixed(6));
  const overageCostUsd = parseFloat((overageCostMicros / 1000000).toFixed(6));
  const totalCurrentCostUsd = parseFloat((basePlanPriceUsd + tokenCostUsd + overageCostUsd).toFixed(2));

  // Recent usage events
  const recentEvents = db.prepare(`
    SELECT id, idempotency_key, event_type, api_calls, input_tokens, cached_input_tokens,
           output_tokens, reasoning_tokens, calculated_cost_micros, created_at
    FROM usage_events
    WHERE tenant_id = ?
    ORDER BY created_at DESC
    LIMIT 5
  `).all(tenantId);

  // Active Alerts
  const alerts = db.prepare(`
    SELECT * FROM usage_alerts
    WHERE tenant_id = ?
    ORDER BY fired_at DESC
  `).all(tenantId);

  const apiCallsRemaining = Math.max(0, plan.quota_api_calls - usage.api_calls);
  const tokensRemaining = Math.max(0, plan.quota_ai_tokens - usage.tokens.total);

  return {
    tenant: {
      id: tenant.id,
      name: tenant.name,
      email: tenant.email,
      status: tenant.status
    },
    plan: {
      id: plan.id,
      name: plan.name,
      monthly_price_usd: basePlanPriceUsd,
      quota_api_calls: plan.quota_api_calls,
      quota_ai_tokens: plan.quota_ai_tokens
    },
    billing_period: {
      start: periodStart,
      end: periodEnd
    },
    usage: {
      api_calls: {
        used: usage.api_calls,
        limit: plan.quota_api_calls,
        remaining: apiCallsRemaining,
        utilization_pct: parseFloat(((usage.api_calls / plan.quota_api_calls) * 100).toFixed(1))
      },
      ai_tokens: {
        categories: {
          input_tokens: {
            count: usage.tokens.input,
            rate_per_1m_usd: PRICING_CONFIG.AI_TOKENS.INPUT_PER_1M_USD,
            cost_usd: parseFloat((inputCostMicros / 1000000).toFixed(6))
          },
          cached_input_tokens: {
            count: usage.tokens.cached_input,
            rate_per_1m_usd: PRICING_CONFIG.AI_TOKENS.CACHED_INPUT_PER_1M_USD,
            discount_pct: '50%',
            cost_usd: parseFloat((cachedCostMicros / 1000000).toFixed(6))
          },
          output_tokens: {
            count: usage.tokens.output,
            rate_per_1m_usd: PRICING_CONFIG.AI_TOKENS.OUTPUT_PER_1M_USD,
            cost_usd: parseFloat((outputCostMicros / 1000000).toFixed(6))
          },
          reasoning_tokens: {
            count: usage.tokens.reasoning,
            rate_per_1m_usd: PRICING_CONFIG.AI_TOKENS.REASONING_PER_1M_USD,
            note: 'Counted at output token rate',
            cost_usd: parseFloat((reasoningCostMicros / 1000000).toFixed(6))
          }
        },
        total_tokens: usage.tokens.total,
        limit: plan.quota_ai_tokens,
        remaining: tokensRemaining,
        utilization_pct: parseFloat(((usage.tokens.total / plan.quota_ai_tokens) * 100).toFixed(1))
      }
    },
    costs: {
      base_subscription_fee_usd: basePlanPriceUsd,
      ai_tokens_usage_usd: tokenCostUsd,
      overage_fee_usd: overageCostUsd,
      total_current_usd: totalCurrentCostUsd
    },
    alerts,
    recent_events: recentEvents
  };
}

module.exports = {
  getTenantUsageSummary
};
