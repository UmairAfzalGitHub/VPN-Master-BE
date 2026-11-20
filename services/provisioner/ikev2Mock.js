'use strict';

/**
 * Mock IKEv2 provisioner: logs what a real strongSwan/RADIUS node WOULD do and
 * returns success without touching any node. Mirrors ./mock.js for WireGuard —
 * it lets the control plane run end-to-end on Render with no IKEv2 node behind
 * it (dev / staging / CI). A tunnel built against a 'mock' ikev2 server will NOT
 * actually authenticate; swap to provisioner='ikev2' with a real agent_url to
 * go live.
 */

async function addCredential({ server, username, remainingBytes, expiresAt }) {
  console.log(
    `[provisioner:ikev2:mock] ${server.id} add EAP user ${username} ` +
      (remainingBytes == null ? '(unlimited)' : `quota=${remainingBytes}B`) +
      (expiresAt ? ` expires=${expiresAt instanceof Date ? expiresAt.toISOString() : expiresAt}` : ''),
  );
  return { ok: true, mock: true };
}

async function removeCredential({ server, username }) {
  console.log(`[provisioner:ikev2:mock] ${server.id} remove EAP user ${username}`);
  return { ok: true, mock: true };
}

async function fetchAccounting({ server }) {
  // No real node — nothing to account. The poller simply records zero deltas.
  console.log(`[provisioner:ikev2:mock] ${server.id} accounting -> (none)`);
  return [];
}

module.exports = { addCredential, removeCredential, fetchAccounting };
