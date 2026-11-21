'use strict';

/**
 * Node provisioner — the seam between the control plane and the IKEv2 nodes
 * (strongSwan + FreeRADIUS). `POST /v1/sessions` calls addCredential as it mints
 * a connect credential; `/sessions/close`, the usage poller (quota) and the
 * reaper call removeCredential; the poller reads fetchAccounting.
 *
 * Each server row chooses its adapter via `servers.provisioner`:
 *   - 'ikev2' -> HTTP calls to the node agent running ON the node (./agent),
 *                which writes the EAP user into FreeRADIUS and reads its
 *                accounting. See servers.agent_url and node-agent/README.md.
 *   - 'mock'  -> no real node (./mock); lets the whole API run end-to-end with
 *                nothing behind it (dev / staging / CI). Such servers report
 *                `available: false`, so apps show them as "Coming soon".
 *
 * Both adapters expose the same contract:
 *   addCredential({ server, username, password, remainingBytes, expiresAt })
 *   removeCredential({ server, username })
 *   fetchAccounting({ server })
 */

const mock = require('./mock');
const agent = require('./agent');

function adapterFor(server) {
  return server.provisioner === 'ikev2' ? agent : mock;
}

/**
 * Provision an EAP credential on a node's RADIUS.
 * @param {object} args
 * @param {object} args.server        server row (provisioner 'ikev2' | 'mock')
 * @param {string} args.username      EAP username
 * @param {string} args.password      EAP password (plaintext; node-side only)
 * @param {number|null} args.remainingBytes  device's remaining monthly allowance
 *   (null = unlimited); the node enforces it with its own accounting sweep.
 * @param {Date|string|null} args.expiresAt  credential validity (connect-gate)
 */
function addCredential(args) {
  return adapterFor(args.server).addCredential(args);
}

/** Remove an EAP credential and CoA-disconnect its live session. */
function removeCredential(args) {
  return adapterFor(args.server).removeCredential(args);
}

/** Pull a node's RADIUS accounting snapshot (usage poller). */
function fetchAccounting(args) {
  return adapterFor(args.server).fetchAccounting(args);
}

module.exports = { adapterFor, addCredential, removeCredential, fetchAccounting };
