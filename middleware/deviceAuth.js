'use strict';

const { verifyDeviceToken } = require('../services/devices');

/**
 * Soft device-token auth. If a valid `Authorization: Bearer <deviceToken>` is
 * present, sets req.device = { id }. If absent or invalid, it does NOT reject —
 * device tokens are optional (BACKEND.md section 2.4) and today's client
 * doesn't send one yet. Downstream code falls back to public-key identity.
 */
function optionalDeviceAuth(req, _res, next) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');
  if (scheme === 'Bearer' && token) {
    try {
      const payload = verifyDeviceToken(token);
      if (payload.kind === 'device' && payload.sub) {
        req.device = { id: payload.sub };
      }
    } catch (_err) {
      // Ignore — treat as anonymous.
    }
  }
  next();
}

module.exports = { optionalDeviceAuth };
