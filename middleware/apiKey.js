'use strict';

/**
 * Static app-key gate. Every /v1 request must carry `X-API-Key: <app_key>`
 * (BACKEND.md sections 1 & 4). Supports multiple comma-separated keys so you
 * can rotate without downtime.
 *
 * Configure with API_KEYS (comma-separated). If unset:
 *   - production  -> the process refuses to serve (fail closed; see server.js).
 *   - non-prod    -> any key is accepted, with a loud warning (dev convenience).
 */

function configuredKeys() {
  return (process.env.API_KEYS || '')
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean);
}

function requireApiKey(req, res, next) {
  const keys = configuredKeys();
  const provided = req.get('X-API-Key');

  if (keys.length === 0) {
    if (process.env.NODE_ENV === 'production') {
      return res.status(401).json({ error: 'Server missing API key configuration' });
    }
    return next(); // dev: allow anything
  }

  if (!provided || !keys.includes(provided)) {
    return res.status(401).json({ error: 'Invalid or missing API key' });
  }
  return next();
}

module.exports = { requireApiKey, configuredKeys };
