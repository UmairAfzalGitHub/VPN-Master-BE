'use strict';

/**
 * Remote config + plan definitions. Everything is env-driven with sane
 * defaults so the plans (data caps) can be tuned without an app release —
 * see BACKEND.md sections 2.7 and 6.
 */

const GB = 1024 * 1024 * 1024;

function num(envVal, fallback) {
  const n = Number(envVal);
  return Number.isFinite(n) ? n : fallback;
}

/** Free tier: 1 GB / month (RX+TX combined) by default. */
function freePlan() {
  return {
    limitBytes: num(process.env.FREE_LIMIT_BYTES, 1 * GB),
    period: process.env.FREE_PERIOD || 'monthly',
  };
}

/**
 * Premium tier. Set PREMIUM_UNLIMITED=true for unlimited, otherwise a byte
 * limit (default 100 GB / month).
 */
function premiumPlan() {
  const unlimited = String(process.env.PREMIUM_UNLIMITED).toLowerCase() === 'true';
  const plan = { period: process.env.PREMIUM_PERIOD || 'monthly' };
  if (unlimited) plan.unlimited = true;
  else plan.limitBytes = num(process.env.PREMIUM_LIMIT_BYTES, 100 * GB);
  return plan;
}

/** Default DNS handed to peers that connect to a node without its own resolver. */
function defaultDns() {
  const raw = process.env.DEFAULT_DNS;
  if (raw) return raw.split(',').map((s) => s.trim()).filter(Boolean);
  return ['1.1.1.1', '1.0.0.1'];
}

/** Body for GET /v1/config. */
function remoteConfig() {
  return {
    termsUrl: process.env.TERMS_URL || 'https://vpnmaster.example.com/terms',
    privacyUrl: process.env.PRIVACY_URL || 'https://vpnmaster.example.com/privacy',
    minSupportedVersion: process.env.MIN_SUPPORTED_VERSION || '1.0.0',
    forceUpdate: String(process.env.FORCE_UPDATE).toLowerCase() === 'true',
    defaultDns: defaultDns(),
    freePlan: freePlan(),
    premiumPlan: premiumPlan(),
  };
}

module.exports = { freePlan, premiumPlan, defaultDns, remoteConfig, GB };
