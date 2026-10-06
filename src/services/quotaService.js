const crypto = require('crypto');
const db = require('../db/connection');

/**
 * Retrieves tenant subscription and quota details
 * @param {string} tenantId
 * @returns {object} Tenant, Subscription, and Plan info
 */
function getTenantSubscriptionDetails(tenantId) {
  const row = db.prepare(`
    SELECT
      t.id as tenant_id, t.name as tenant_name, t.email, t.status as tenant_status, t.stripe_customer_id,
      s.id as subscription_id, s.status as subscription_status, s.stripe_subscription_id,
      s.current_period_start, s.current_period_end,
      p.id as plan_id, p.name as plan_name, p.monthly_price_cents,
      p.quota_api_calls, p.quota_ai_tokens, p.overage_rate_api_call_micros, p.features
    FROM tenants t
    LEFT JOIN subscriptions s ON t.id = s.tenant_id
    LEFT JOIN plans p ON s.plan_id = p.id
    WHERE t.id = ?
  `).get(tenantId);

  if (!row) {
    throw new Error(`Tenant "${tenantId}" not found`);
  }

  return {
    tenant: {
      id: row.tenant_id,
      name: row.tenant_name,
      email: row.email,
      status: row.tenant_status,
      stripe_customer_id: row.stripe_customer_id
    },
    subscription: {
      id: row.subscription_id,
      status: row.subscription_status || 'active',
      plan_id: row.plan_id || 'free',
      stripe_subscription_id: row.stripe_subscription_id,
      current_period_start: row.current_period_start,
      current_period_end: row.current_period_end
    },
    plan: {
      id: row.plan_id || 'free',
      name: row.plan_name || 'Free Developer Plan',
      monthly_price_cents: row.monthly_price_cents || 0,
      quota_api_calls: row.quota_api_calls || 1000,
      quota_ai_tokens: row.quota_ai_tokens || 100000,
      overage_rate_api_call_micros: row.overage_rate_api_call_micros || 1000,
      features: row.features ? JSON.parse(row.features) : []
    }
  };
}

/**
 * Aggregates current usage in the active billing period
 * @param {string} tenantId
 * @param {string} periodStart
 * @param {string} periodEnd
 * @returns {object} Current period usage totals
 */
function getCurrentPeriodUsage(tenantId, periodStart, periodEnd) {
  const stats = db.prepare(`
    SELECT
      COALESCE(SUM(api_calls), 0) as total_api_calls,
      COALESCE(SUM(input_tokens), 0) as total_input_tokens,
      COALESCE(SUM(cached_input_tokens), 0) as total_cached_input_tokens,
      COALESCE(SUM(output_tokens), 0) as total_output_tokens,
      COALESCE(SUM(reasoning_tokens), 0) as total_reasoning_tokens,
      COALESCE(SUM(calculated_cost_micros), 0) as total_cost_micros,
      COUNT(*) as total_events
    FROM usage_events
    WHERE tenant_id = ?
      AND created_at >= ?
      AND created_at < ?
  `).get(tenantId, periodStart, periodEnd);

  const totalTokens = (
    stats.total_input_tokens +
    stats.total_cached_input_tokens +
    stats.total_output_tokens +
    stats.total_reasoning_tokens
  );

  return {
    api_calls: stats.total_api_calls,
    tokens: {
      input: stats.total_input_tokens,
      cached_input: stats.total_cached_input_tokens,
      output: stats.total_output_tokens,
      reasoning: stats.total_reasoning_tokens,
      total: totalTokens
    },
    cost_micros: stats.total_cost_micros,
    total_events: stats.total_events
  };
}

/**
 * Checks usage against quota limits before allowing billable action
 * @param {string} tenantId
 * @param {object} requested
 * @param {number} [requested.api_calls=1]
 * @param {number} [requested.input_tokens=0]
 * @param {number} [requested.cached_input_tokens=0]
 * @param {number} [requested.output_tokens=0]
 * @param {number} [requested.reasoning_tokens=0]
 * @returns {object} { allowed: boolean, statusCode: number, reason?: string, details: object }
 */
function checkQuota(tenantId, requested = { api_calls: 1 }) {
  const details = getTenantSubscriptionDetails(tenantId);
  const { tenant, subscription, plan } = details;

  // Account Status Check
  if (tenant.status !== 'active') {
    return {
      allowed: false,
      statusCode: 402,
      errorCode: 'TENANT_SUSPENDED',
      reason: `Account is ${tenant.status}. Please resolve billing status to resume service.`,
      details
    };
  }

  if (subscription.status !== 'active' && subscription.status !== 'trialing') {
    return {
      allowed: false,
      statusCode: 402,
      errorCode: 'SUBSCRIPTION_INACTIVE',
      reason: `Subscription is currently "${subscription.status}". Payment required to access API.`,
      details
    };
  }

  // Get current billing period
  const now = new Date();
  const periodStart = subscription.current_period_start || new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  const periodEnd = subscription.current_period_end || new Date(now.getFullYear(), now.getMonth() + 1, 1).toISOString();

  const currentUsage = getCurrentPeriodUsage(tenantId, periodStart, periodEnd);

  const reqCalls = requested.api_calls || 1;
  const reqTokens = (requested.inputTokens || 0) + (requested.cachedInputTokens || 0) + (requested.outputTokens || 0) + (requested.reasoningTokens || 0);

  const projectedCalls = currentUsage.api_calls + reqCalls;
  const projectedTokens = currentUsage.tokens.total + reqTokens;

  // 1. API Calls Quota Check
  if (projectedCalls > plan.quota_api_calls) {
    const isFree = plan.id === 'free';
    const statusCode = isFree ? 429 : 429;
    return {
      allowed: false,
      statusCode,
      errorCode: 'QUOTA_EXCEEDED_API_CALLS',
      reason: `Monthly API call quota exceeded (${currentUsage.api_calls}/${plan.quota_api_calls} used). Upgrade to Pro for higher limits.`,
      metric: 'api_calls',
      current: currentUsage.api_calls,
      requested: reqCalls,
      limit: plan.quota_api_calls,
      plan: plan.name
    };
  }

  // 2. AI Tokens Quota Check
  if (projectedTokens > plan.quota_ai_tokens) {
    return {
      allowed: false,
      statusCode: 429,
      errorCode: 'QUOTA_EXCEEDED_AI_TOKENS',
      reason: `Monthly AI token quota exceeded (${currentUsage.tokens.total.toLocaleString()}/${plan.quota_ai_tokens.toLocaleString()} tokens used). Upgrade required.`,
      metric: 'ai_tokens',
      current: currentUsage.tokens.total,
      requested: reqTokens,
      limit: plan.quota_ai_tokens,
      plan: plan.name
    };
  }

  // Quota Passed
  return {
    allowed: true,
    statusCode: 200,
    currentUsage,
    plan,
    remaining: {
      api_calls: plan.quota_api_calls - currentUsage.api_calls,
      tokens: plan.quota_ai_tokens - currentUsage.tokens.total
    }
  };
}

/**
 * Checks and records usage alerts when thresholds (80%, 100%) are crossed
 * @param {string} tenantId
 * @param {number} currentCalls
 * @param {number} maxCalls
 * @param {number} currentTokens
 * @param {number} maxTokens
 */
function triggerUsageAlertsIfNeeded(tenantId, currentCalls, maxCalls, currentTokens, maxTokens) {
  const insertAlert = db.prepare(`
    INSERT INTO usage_alerts (id, tenant_id, metric, threshold_pct, current_usage, quota_limit)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  // Check API calls thresholds
  const callPct = Math.floor((currentCalls / maxCalls) * 100);
  if (callPct >= 80) {
    const threshold = callPct >= 100 ? 100 : 80;
    const existing = db.prepare("SELECT id FROM usage_alerts WHERE tenant_id = ? AND metric = 'api_calls' AND threshold_pct = ?").get(tenantId, threshold);
    if (!existing) {
      insertAlert.run('alt-' + crypto.randomUUID(), tenantId, 'api_calls', threshold, currentCalls, maxCalls);
      console.log(`🔔 [Usage Alert] Tenant ${tenantId} reached ${threshold}% of API call quota (${currentCalls}/${maxCalls})`);
    }
  }

  // Check Tokens thresholds
  const tokenPct = Math.floor((currentTokens / maxTokens) * 100);
  if (tokenPct >= 80) {
    const threshold = tokenPct >= 100 ? 100 : 80;
    const existing = db.prepare("SELECT id FROM usage_alerts WHERE tenant_id = ? AND metric = 'ai_tokens' AND threshold_pct = ?").get(tenantId, threshold);
    if (!existing) {
      insertAlert.run('alt-' + crypto.randomUUID(), tenantId, 'ai_tokens', threshold, currentTokens, maxTokens);
      console.log(`🔔 [Usage Alert] Tenant ${tenantId} reached ${threshold}% of AI token quota (${currentTokens}/${maxTokens})`);
    }
  }
}

module.exports = {
  getTenantSubscriptionDetails,
  getCurrentPeriodUsage,
  checkQuota,
  triggerUsageAlertsIfNeeded
};
