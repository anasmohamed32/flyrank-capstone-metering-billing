const fs = require('fs');
const path = require('path');
const db = require('./connection');

function runMigrations() {
  const schemaSql = fs.readFileSync(path.resolve(__dirname, 'schema.sql'), 'utf8');
  db.exec(schemaSql);
  console.log('✅ [DB Migration] Usage Metering & Billing Engine schema migrated successfully.');
}

if (require.main === module) {
  runMigrations();
}

module.exports = { runMigrations };
