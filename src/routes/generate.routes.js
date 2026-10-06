const express = require('express');
const { z } = require('zod');
const { recordUsageEvent } = require('../services/meterService');
const { microsToUsdString } = require('../config/pricing.config');

const router = express.Router();

const GenerateRequestSchema = z.object({
  tenant_id: z.string().min(1, 'tenant_id is required'),
  prompt: z.string().min(1, 'prompt is required'),
  input_tokens: z.number().int().min(0).optional().default(100),
  cached_input_tokens: z.number().int().min(0).optional().default(0),
  output_tokens: z.number().int().min(0).optional().default(50),
  reasoning_tokens: z.number().int().min(0).optional().default(0),
  model: z.string().optional().default('gpt-4o-mini'),
  idempotency_key: z.string().optional()
});

/**
 * POST /api/v1/generate
 * Dummy Billable Action Endpoint — Exercises Idempotent Metering, Quota Checks & Money Math
 */
router.post('/', (req, res) => {
  const parseResult = GenerateRequestSchema.safeParse(req.body);
  if (!parseResult.success) {
    return res.status(400).json({
      error: 'Validation failed',
      details: parseResult.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`)
    });
  }

  const {
    tenant_id,
    prompt,
    input_tokens,
    cached_input_tokens,
    output_tokens,
    reasoning_tokens,
    model
  } = parseResult.data;

  // Retrieve idempotency key from header or body
  const idempotencyKey = req.headers['idempotency-key'] || parseResult.data.idempotency_key;

  if (!idempotencyKey) {
    return res.status(400).json({
      error: 'Missing Idempotency-Key',
      message: 'Every billable request must provide an Idempotency-Key header or idempotency_key parameter.'
    });
  }

  try {
    const meterResult = recordUsageEvent({
      tenantId: tenant_id,
      idempotencyKey,
      eventType: 'ai_generation',
      apiCalls: 1,
      inputTokens: input_tokens,
      cachedInputTokens: cached_input_tokens,
      outputTokens: output_tokens,
      reasoningTokens: reasoning_tokens,
      metadata: { prompt, model }
    });

    if (meterResult.isReplay) {
      res.setHeader('Idempotent-Replay', 'true');
    }

    if (!meterResult.allowed) {
      return res.status(meterResult.statusCode).json({
        error: meterResult.errorCode || 'Quota Exceeded',
        message: meterResult.reason,
        details: meterResult.quotaDetails
      });
    }

    const event = meterResult.event;
    return res.status(200).json({
      success: true,
      message: meterResult.isReplay
        ? 'Idempotent replay: cached response returned'
        : 'Generated response and recorded metered usage',
      generated_response: `Simulated AI completion for "${prompt.slice(0, 35)}..." [Model: ${model}]`,
      usage: {
        event_id: event.id,
        idempotency_key: event.idempotency_key,
        api_calls: event.api_calls,
        input_tokens: event.input_tokens,
        cached_input_tokens: event.cached_input_tokens,
        output_tokens: event.output_tokens,
        reasoning_tokens: event.reasoning_tokens,
        calculated_cost_usd: microsToUsdString(event.calculated_cost_micros)
      }
    });
  } catch (err) {
    console.error('💥 [Generate Route Error]:', err);
    if (err.message && err.message.includes('not found')) {
      return res.status(404).json({ error: 'Tenant Not Found', message: err.message });
    }
    return res.status(500).json({ error: 'Internal Server Error', message: err.message });
  }
});

module.exports = router;
