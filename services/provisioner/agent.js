'use strict';

/**
 * Agent provisioner: talks to a small HTTP agent running ON the WireGuard node
 * (servers.agent_url). The agent is the only thing that touches `wg` and
 * `nftables`; the control plane never needs SSH or root on the node.
 *
 * This adapter defines the contract the node agent must implement. The agent
 * itself is deployed separately on each Linux node (it needs a real kernel +
 * WireGuard) — see BACKEND.md section 3 and README "Deploying a real node".
 *
 *   POST   {agent_url}/peers  -> add/refresh a peer, arm nftables quota
 *     body: { publicKey, assignedIp, presharedKey, remainingBytes }
 *   DELETE {agent_url}/peers  -> remove a peer, drop enforcement + free IP
 *     body: { publicKey }
 *
 * Auth: header `X-Agent-Secret: <NODE_AGENT_SECRET>` (shared with the agent;
 * verified against the running node agent's contract).
 */

const { requestJson } = require('./nodeHttp');

const NODE_AGENT_SECRET = process.env.NODE_AGENT_SECRET || '';
const TIMEOUT_MS = Number(process.env.NODE_AGENT_TIMEOUT_MS || 8000);

async function call(server, method, path, body) {
  if (!server.agent_url) {
    throw new Error(`server ${server.id} has provisioner='agent' but no agent_url`);
  }
  const url = `${server.agent_url.replace(/\/$/, '')}${path}`;
  const res = await requestJson(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Agent-Secret': NODE_AGENT_SECRET,
    },
    body: JSON.stringify(body),
    timeoutMs: TIMEOUT_MS,
  });
  if (!res.ok) {
    throw new Error(`node agent ${server.id} ${method} ${path} -> ${res.status} ${res.text || ''}`);
  }
  return res.data ?? { ok: true };
}

async function addPeer({ server, publicKey, assignedIp, presharedKey, remainingBytes }) {
  return call(server, 'POST', '/peers', {
    publicKey,
    assignedIp,
    presharedKey: presharedKey || null,
    // null => unlimited (premium); the agent skips the quota object in that case.
    remainingBytes: remainingBytes == null ? null : Math.round(remainingBytes),
  });
}

async function removePeer({ server, publicKey }) {
  return call(server, 'DELETE', '/peers', { publicKey });
}

module.exports = { addPeer, removePeer };
