const app = require('./app');
const { runMigrations } = require('./db/migrate');
require('dotenv').config();

const PORT = process.env.PORT || 3000;

// Ensure database schema is migrated on boot
runMigrations();

const server = app.listen(PORT, () => {
  console.log('\n================================================================');
  console.log('⚡ FlyRank Usage Metering & Billing Engine');
  console.log(`🚀 Server listening on http://localhost:${PORT}`);
  console.log('💳 Stripe Test Mode: ACTIVE (Signature Verification & Webhook Deduplication)');
  console.log('🔢 Money Math: Exact Integer Units (Cents & Micro-Units)');
  console.log('================================================================\n');
});

module.exports = server;
