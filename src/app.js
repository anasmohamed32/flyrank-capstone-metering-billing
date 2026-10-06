const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const path = require('path');

const generateRoutes = require('./routes/generate.routes');
const usageRoutes = require('./routes/usage.routes');
const billingRoutes = require('./routes/billing.routes');
const webhookRoutes = require('./routes/webhook.routes');
const db = require('./db/connection');

const app = express();

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());

if (process.env.NODE_ENV !== 'test') {
  app.use(morgan('dev'));
}

// Special raw body capture for Stripe Webhook Signature Verification
app.use('/api/v1/webhooks', express.raw({ type: '*/*', limit: '2mb' }), (req, res, next) => {
  if (Buffer.isBuffer(req.body)) {
    req.rawBody = req.body;
  }
  next();
});
app.use('/webhooks', express.raw({ type: '*/*', limit: '2mb' }), (req, res, next) => {
  if (Buffer.isBuffer(req.body)) {
    req.rawBody = req.body;
  }
  next();
});

// JSON and URL-encoded body parser for all other routes
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Health Check
app.get('/health', (req, res) => {
  try {
    const dbCheck = db.prepare('SELECT 1 as alive').get();
    res.status(200).json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      database: dbCheck.alive === 1 ? 'connected' : 'disconnected'
    });
  } catch (err) {
    res.status(500).json({ status: 'unhealthy', error: err.message });
  }
});

// Primary API Routes
app.use('/api/v1/generate', generateRoutes);
app.use('/generate', generateRoutes);

app.use('/api/v1/usage', usageRoutes);
app.use('/usage', usageRoutes);

app.use('/api/v1/billing', billingRoutes);

app.use('/api/v1/webhooks', webhookRoutes);
app.use('/webhooks', webhookRoutes);

// 404 Handler
app.use((req, res) => {
  res.status(404).json({ error: `Cannot ${req.method} ${req.path}` });
});

// Global Error Handler
app.use((err, req, res, next) => {
  console.error('Unhandled server error:', err);
  res.status(500).json({ error: 'Internal Server Error', message: err.message });
});

module.exports = app;
