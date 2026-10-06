const express = require('express');
const crypto = require('crypto');
const { z } = require('zod');
const db = require('../db/connection');
const { getTenantUsageSummary } = require('../services/usageRollupService');
const { recordUsageEvent } = require('../services/meterService');

const router = express.Router();

/**
 * GET /api/v1/usage & GET /api/v1/usage/:tenant_id
 * Returns complete usage metrics, quota limits, and money math breakdown
 */
router.get('/', (req, res) => {
  const tenantId = req.query.tenant_id || 'tenant-acme-free';
  try {
    const summary = getTenantUsageSummary(tenantId);
    return res.status(200).json(summary);
  } catch (err) {
    return res.status(404).json({ error: 'Tenant Not Found', message: err.message });
  }
});

router.get('/:tenant_id', (req, res) => {
  const tenantId = req.params.tenant_id;
  try {
    const summary = getTenantUsageSummary(tenantId);
    return res.status(200).json(summary);
  } catch (err) {
    return res.status(404).json({ error: 'Tenant Not Found', message: err.message });
  }
});

/**
 * GET /api/v1/plans
 */
router.get('/plans/list', (req, res) => {
  const plans = db.prepare('SELECT * FROM plans ORDER BY monthly_price_cents ASC').all().map((p) => ({
    ...p,
    features: p.features ? JSON.parse(p.features) : []
  }));
  return res.status(200).json({ plans });
});

/**
 * GET /api/v1/tenants
 */
router.get('/tenants/list', (req, res) => {
  const tenants = db.prepare(`
    SELECT t.*, s.plan_id, s.status as subscription_status, p.name as plan_name
    FROM tenants t
    LEFT JOIN subscriptions s ON t.id = s.tenant_id
    LEFT JOIN plans p ON s.plan_id = p.id
    ORDER BY t.created_at ASC
  `).all();
  return res.status(200).json({ total: tenants.length, tenants });
});

/**
 * POST /api/v1/usage/record
 * Record custom usage event directly
 */
router.post('/record', (req, res) => {
  const {
    tenant_id,
    idempotency_key,
    event_type = 'api_call',
    api_calls = 1,
    input_tokens = 0,
    cached_input_tokens = 0,
    output_tokens = 0,
    reasoning_tokens = 0,
    metadata = {}
  } = req.body;

  const key = req.headers['idempotency-key'] || idempotency_key;

  if (!tenant_id || !key) {
    return res.status(400).json({
      error: 'Missing required parameters: tenant_id and idempotency_key are required.'
    });
  }

  try {
    const result = recordUsageEvent({
      tenantId: tenant_id,
      idempotencyKey: key,
      eventType: event_type,
      apiCalls: api_calls,
      inputTokens: input_tokens,
      cachedInputTokens: cached_input_tokens,
      outputTokens: output_tokens,
      reasoningTokens: reasoning_tokens,
      metadata
    });

    if (result.isReplay) {
      res.setHeader('Idempotent-Replay', 'true');
    }

    if (!result.allowed) {
      return res.status(result.statusCode).json({
        error: result.errorCode,
        message: result.reason,
        details: result.quotaDetails
      });
    }

    return res.status(200).json({
      success: true,
      is_replay: result.isReplay,
      event: result.event
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
