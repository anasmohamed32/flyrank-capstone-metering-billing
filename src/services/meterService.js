const crypto = require('crypto');
const db = require('../db/connection');
const { calculateTokenCostMicros } = require('../config/pricing.config');
const { checkQuota, triggerUsageAlertsIfNeeded, getTenantSubscriptionDetails, getCurrentPeriodUsage } = require('./quotaService');

/**
 * Record a billable usage event with strict idempotency guarantees
 * @param {object} params
 * @param {string} params.tenantId
 * @param {string} params.idempotencyKey
 * @param {'api_call'|'ai_generation'|'batch_job'} [params.eventType='api_call']
 * @param {number} [params.apiCalls=1]
 * @param {number} [params.inputTokens=0]
 * @param {number} [params.cachedInputTokens=0]
 * @param {number} [params.outputTokens=0]
 * @param {number} [params.reasoningTokens=0]
 * @param {object} [params.metadata={}]
 * @returns {object} { event: object, isReplay: boolean, allowed: boolean, statusCode: number }
 */
function recordUsageEvent({
  tenantId,
  idempotencyKey,
  eventType = 'api_call',
  apiCalls = 1,
  inputTokens = 0,
  cachedInputTokens = 0,
  outputTokens = 0,
  reasoningTokens = 0,
  metadata = {}
}) {
  if (!idempotencyKey || typeof idempotencyKey !== 'string') {
    throw new Error('idempotencyKey is required for every billable usage event');
  }

  // 1. Idempotency Check (Non-negotiable exactly-once guarantee)
  const existingEvent = db.prepare('SELECT * FROM usage_events WHERE idempotency_key = ?').get(idempotencyKey);
  if (existingEvent) {
    return {
      isReplay: true,
      allowed: true,
      statusCode: 200,
      message: 'Idempotent replay: usage event already recorded',
      event: {
        ...existingEvent,
        metadata: JSON.parse(existingEvent.metadata)
      }
    };
  }

  // 2. Quota Check before recording new usage
  const quotaCheck = checkQuota(tenantId, {
    api_calls: apiCalls,
    inputTokens,
    cachedInputTokens,
    outputTokens,
    reasoningTokens
  });

  if (!quotaCheck.allowed) {
    return {
      isReplay: false,
      allowed: false,
      statusCode: quotaCheck.statusCode,
      errorCode: quotaCheck.errorCode,
      reason: quotaCheck.reason,
      quotaDetails: quotaCheck
    };
  }

  // 3. Compute Exact Integer Token Cost in Micro-units
  const calculatedCostMicros = calculateTokenCostMicros({
    inputTokens,
    cachedInputTokens,
    outputTokens,
    reasoningTokens
  });

  const eventId = 'evt-' + crypto.randomUUID();
  const insertUsage = db.prepare(`
    INSERT INTO usage_events (
      id, tenant_id, idempotency_key, event_type, api_calls,
      input_tokens, cached_input_tokens, output_tokens, reasoning_tokens,
      calculated_cost_micros, metadata
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  insertUsage.run(
    eventId,
    tenantId,
    idempotencyKey,
    eventType,
    apiCalls,
    inputTokens,
    cachedInputTokens,
    outputTokens,
    reasoningTokens,
    calculatedCostMicros,
    JSON.stringify(metadata)
  );

  const recorded = db.prepare('SELECT * FROM usage_events WHERE id = ?').get(eventId);

  // 4. Check Alert Thresholds (80% / 100%)
  const subDetails = getTenantSubscriptionDetails(tenantId);
  const now = new Date();
  const periodStart = subDetails.subscription.current_period_start || new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  const periodEnd = subDetails.subscription.current_period_end || new Date(now.getFullYear(), now.getMonth() + 1, 1).toISOString();
  const updatedUsage = getCurrentPeriodUsage(tenantId, periodStart, periodEnd);

  triggerUsageAlertsIfNeeded(
    tenantId,
    updatedUsage.api_calls,
    subDetails.plan.quota_api_calls,
    updatedUsage.tokens.total,
    subDetails.plan.quota_ai_tokens
  );

  return {
    isReplay: false,
    allowed: true,
    statusCode: 200,
    event: {
      ...recorded,
      metadata: JSON.parse(recorded.metadata)
    }
  };
}

module.exports = {
  recordUsageEvent
};
