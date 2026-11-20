'use strict';

/**
 * Node provisioner — the seam between the control plane and the actual
 * WireGuard nodes (BACKEND.md section 3). `/sessions` calls addPeer as it
 * hands out an allocation; `/sessions/close` and the reaper call removePeer.
 *
 * Each server row chooses its adapter via `servers.provisioner`:
 *   - 'mock'  -> no real wg calls; lets the whole API run end-to-end on Render
 *               with no Linux node behind it (dev / staging / CI).
 *   - 'agent' -> HTTP calls to a small agent process running ON the node, which
 *               runs `wg set ...` and programs the in-kernel nftables byte
 *               quota. See servers.agent_url.
 *
 * Both adapters expose the same contract:
 *   addPeer({ server, publicKey, assignedIp, presharedKey, remainingBytes })
 *   removePeer({ server, publicKey })
 */

const mock = require('./mock');
const agent = require('./agent');
const ikev2Mock = require('./ikev2Mock');
const ikev2Agent = require('./ikev2Agent');

function adapterFor(server) {
  switch (server.provisioner) {
    case 'agent':
      return agent;
    case 'mock':
    default:
      return mock;
  }
}

/**
 * IKEv2 adapter for a server. Selected by `servers.provisioner`:
 *   - 'ikev2' -> the strongSwan/RADIUS node agent (ikev2Agent)
 *   - 'mock'  -> ikev2Mock (no node; dev / staging / CI)
 * Exposes addCredential / removeCredential / fetchAccounting.
 */
function ikev2AdapterFor(server) {
  switch (server.provisioner) {
    case 'ikev2':
      return ikev2Agent;
    case 'mock':
    default:
      return ikev2Mock;
  }
}

/**
 * Program a peer on its node.
 * @param {object} args
 * @param {object} args.server        server row
 * @param {string} args.publicKey     client wg public key
 * @param {string} args.assignedIp    host address, e.g. "10.7.0.23"
 * @param {string|null} args.presharedKey
 * @param {number|null} args.remainingBytes  the device's remaining monthly
 *   allowance; the node arms an nftables quota with THIS, not the full plan.
 */
function addPeer(args) {
  return adapterFor(args.server).addPeer(args);
}

/** Remove a peer from its node and free enforcement state. */
function removePeer(args) {
  return adapterFor(args.server).removePeer(args);
}

// --- IKEv2 (strongSwan/RADIUS) --------------------------------------------
// Parallel surface to addPeer/removePeer for protocol='ikev2' servers.

/**
 * Provision an EAP credential on an IKEv2 node's RADIUS.
 * @param {object} args
 * @param {object} args.server        server row (provisioner 'ikev2' | 'mock')
 * @param {string} args.username      EAP username
 * @param {string} args.password      EAP password (plaintext; node-side only)
 * @param {number|null} args.remainingBytes  device's remaining monthly allowance
 * @param {Date|string|null} args.expiresAt  credential validity (connect-gate)
 */
function addCredential(args) {
  return ikev2AdapterFor(args.server).addCredential(args);
}

/** Remove an EAP credential and CoA-disconnect its live session. */
function removeCredential(args) {
  return ikev2AdapterFor(args.server).removeCredential(args);
}

/** Pull a node's RADIUS accounting snapshot (usage poller). */
function fetchAccounting(args) {
  return ikev2AdapterFor(args.server).fetchAccounting(args);
}

module.exports = {
  addPeer,
  removePeer,
  adapterFor,
  addCredential,
  removeCredential,
  fetchAccounting,
  ikev2AdapterFor,
};
