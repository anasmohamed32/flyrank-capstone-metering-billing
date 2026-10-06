const express = require('express');
const { createCheckoutSession } = require('../services/stripeService');
const { generateInvoice, reconcileSubscriptions } = require('../services/invoiceService');
const db = require('../db/connection');

const router = express.Router();

/**
 * POST /api/v1/billing/checkout
 * Create Stripe Checkout Session for subscription upgrade
 */
router.post('/checkout', async (req, res) => {
  const { tenant_id, plan_id = 'pro', success_url, cancel_url } = req.body;

  if (!tenant_id) {
    return res.status(400).json({ error: 'tenant_id is required' });
  }

  try {
    const session = await createCheckoutSession({
      tenantId: tenant_id,
      planId: plan_id,
      successUrl: success_url,
      cancelUrl: cancel_url
    });

    return res.status(200).json({
      message: 'Stripe test checkout session created',
      ...session
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/v1/billing/invoices/generate
 */
router.post('/invoices/generate', (req, res) => {
  const { tenant_id } = req.body;
  if (!tenant_id) {
    return res.status(400).json({ error: 'tenant_id is required' });
  }

  try {
    const invoice = generateInvoice(tenant_id);
    return res.status(201).json({
      message: 'Invoice generated successfully',
      invoice: {
        ...invoice,
        line_items: JSON.parse(invoice.line_items)
      }
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/v1/billing/invoices/:tenant_id
 */
router.get('/invoices/:tenant_id', (req, res) => {
  const invoices = db.prepare('SELECT * FROM invoices WHERE tenant_id = ? ORDER BY created_at DESC').all(req.params.tenant_id);
  return res.status(200).json({
    total: invoices.length,
    invoices: invoices.map((inv) => ({
      ...inv,
      line_items: JSON.parse(inv.line_items)
    }))
  });
});

/**
 * GET /api/v1/billing/reconcile (Stretch Goal)
 */
router.get('/reconcile', (req, res) => {
  const report = reconcileSubscriptions();
  return res.status(200).json(report);
});

module.exports = router;
