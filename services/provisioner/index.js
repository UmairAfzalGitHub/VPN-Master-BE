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

module.exports = { addPeer, removePeer, adapterFor };
