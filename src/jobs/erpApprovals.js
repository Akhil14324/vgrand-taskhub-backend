const erp = require('../services/erpApprovals');

// Re-checks every linked person's Hospital ERP approvals in case an "approvals changed" call from the ERP was
// missed (deploy, network). The first run after start only records what is already waiting (no notifications).
const INTERVAL_MS = 10 * 60 * 1000;
const FIRST_RUN_MS = 30 * 1000;

function scheduleErpApprovals() {
  if (!erp.isConfigured()) {
    console.log('[erp] ERP_API_URL / TASKHUB_SYNC_SECRET not set: Hospital ERP approvals are off');
    return;
  }
  setTimeout(() => erp.syncAll(), FIRST_RUN_MS).unref();
  setInterval(() => erp.syncAll(), INTERVAL_MS).unref();
}

module.exports = { scheduleErpApprovals };
