'use strict';

/**
 * Mock provisioner: logs what a real node WOULD do and returns success without
 * touching any WireGuard interface. This is what lets the control plane run on
 * Render (or locally) with no Linux WG node behind it.
 *
 * A tunnel built against a 'mock' server will NOT actually hand-shake — the
 * seed servers' public keys are placeholders. Swap a server to
 * provisioner='agent' with a real endpoint/public_key/agent_url to go live.
 */

async function addPeer({ server, publicKey, assignedIp, presharedKey, remainingBytes }) {
  console.log(
    `[provisioner:mock] ${server.id} add peer ${publicKey.slice(0, 12)}… ` +
      `-> ${assignedIp}/32` +
      (presharedKey ? ' (+psk)' : '') +
      (remainingBytes == null ? ' (unlimited)' : ` quota=${remainingBytes}B`),
  );
  // Real node equivalent (run on the node):
  //   wg set wg0 peer <publicKey> allowed-ips <assignedIp>/32 [preshared-key <psk>]
  //   nft add element inet wgquota ...  (arm remainingBytes quota)
  return { ok: true, mock: true };
}

async function removePeer({ server, publicKey }) {
  console.log(`[provisioner:mock] ${server.id} remove peer ${publicKey.slice(0, 12)}…`);
  // Real node equivalent: wg set wg0 peer <publicKey> remove
  return { ok: true, mock: true };
}

module.exports = { addPeer, removePeer };
