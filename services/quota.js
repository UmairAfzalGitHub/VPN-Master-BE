'use strict';

const { query, pool } = require('../db/pool');
const { freePlan, premiumPlan } = require('./config');

/**
 * Quota ledger. Postgres holds the authoritative monthly RX+TX total per
 * DEVICE; the node kernel is the real enforcer (BACKEND.md section 6). These
 * helpers decide the numbers and keep the ledger.
 */

/** First day of the current month, 00:00 UTC, as a JS Date. */
function currentPeriodStart(now = new Date()) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/** First day of the NEXT month, 00:00 UTC — when the counter resets. */
function nextPeriodStart(now = new Date()) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
}

/** "YYYY-MM-DD" for a period-start Date (matches the DATE column). */
function periodKey(date) {
  return date.toISOString().slice(0, 10);
}

/** Is this device on the premium plan right now? */
function isPremiumActive(device) {
  if (!device || !device.is_premium) return false;
  if (!device.premium_expires_at) return true; // premium with no expiry
  return new Date(device.premium_expires_at).getTime() > Date.now();
}

/**
 * Bytes this device has used in the current period (0 if no row yet).
 * @param {string} deviceId
 */
async function usedBytesThisPeriod(deviceId) {
  const key = periodKey(currentPeriodStart());
  const { rows } = await query(
    'SELECT used_bytes FROM usage_counters WHERE device_id = $1 AND period_start = $2',
    [deviceId, key],
  );
  return rows.length ? Number(rows[0].used_bytes) : 0;
}

/**
 * Build the `quota` snapshot returned by /sessions and /usage.
 * @param {object} device  a row from `devices`
 * @returns {Promise<object>} matches the client's Quota shape
 */
async function quotaFor(device) {
  const premium = isPremiumActive(device);
  const plan = premium ? premiumPlan() : freePlan();
  const used = await usedBytesThisPeriod(device.id);
  const resetsAt = nextPeriodStart().toISOString();

  if (plan.unlimited) {
    return {
      // `isPremium` tells the client the tier regardless of the cap — premium is
      // now a metered plan (10 GB), so `unlimited` alone no longer means premium.
      isPremium: premium,
      unlimited: true,
      usedBytes: used,
      period: plan.period,
      resetsAt,
    };
  }

  const limit = plan.limitBytes;
  const remaining = Math.max(0, limit - used);
  return {
    isPremium: premium,
    unlimited: false,
    limitBytes: limit,
    usedBytes: used,
    remainingBytes: remaining,
    period: plan.period,
    resetsAt,
  };
}

/**
 * Add a positive byte delta to a device's current-period counter, creating the
 * period row on first use. Called when a node agent reports RX+TX deltas.
 * @param {string} deviceId
 * @param {number} deltaBytes  non-negative
 */
async function addUsage(deviceId, deltaBytes, client = pool) {
  if (!deltaBytes || deltaBytes <= 0) return;
  const key = periodKey(currentPeriodStart());
  await client.query(
    `INSERT INTO usage_counters (device_id, period_start, used_bytes, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (device_id, period_start)
     DO UPDATE SET used_bytes = usage_counters.used_bytes + EXCLUDED.used_bytes,
                   updated_at = now()`,
    [deviceId, key, Math.round(deltaBytes)],
  );
}

/**
 * Is a quota body "exhausted"? (metered plan with nothing left.)
 * Unlimited/premium never is.
 */
function isExhausted(quota) {
  return !quota.unlimited && Number(quota.remainingBytes) <= 0;
}

module.exports = {
  currentPeriodStart,
  nextPeriodStart,
  periodKey,
  isPremiumActive,
  usedBytesThisPeriod,
  quotaFor,
  addUsage,
  isExhausted,
};
