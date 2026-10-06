const express = require('express');
const { verifyWebhookSignature, processStripeWebhookEvent } = require('../services/stripeService');

const router = express.Router();

/**
 * POST /api/v1/webhooks/stripe & POST /webhooks/stripe
 * Signature-verified, idempotent Stripe webhook endpoint
 */
router.post('/stripe', (req, res) => {
  const signature = req.headers['stripe-signature'];

  if (!signature) {
    return res.status(400).json({
      error: 'Missing Signature Header',
      message: 'Every Stripe webhook request must carry a valid stripe-signature header.'
    });
  }

  let event;
  try {
    // req.rawBody or req.body
    const rawPayload = req.rawBody || req.body;
    event = verifyWebhookSignature(rawPayload, signature);
  } catch (err) {
    console.warn(`🛑 [Stripe Webhook Guard] Forged or invalid webhook signature rejected: ${err.message}`);
    return res.status(400).json({
      error: 'Invalid Signature',
      message: err.message
    });
  }

  try {
    const result = processStripeWebhookEvent(event);
    return res.status(200).json({
      received: true,
      result
    });
  } catch (err) {
    console.error('💥 [Stripe Webhook Processing Error]:', err);
    return res.status(500).json({
      error: 'Webhook Processing Error',
      message: err.message
    });
  }
});

module.exports = router;
