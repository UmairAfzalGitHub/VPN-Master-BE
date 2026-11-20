'use strict';

/**
 * IKEv2 agent provisioner: talks to the strongSwan/RADIUS node agent running ON
 * an IKEv2 node (servers.agent_url, servers.provisioner = 'ikev2'). It is the
 * IKEv2 analogue of ./agent.js — the control plane never SSHes or touches
 * strongSwan/FreeRADIUS directly.
 *
 * Contract the node agent must implement (see node-agent-ikev2/README.md):
 *   POST   {agent_url}/credentials  -> add/refresh an EAP user, arm its quota
 *     body: { username, password, remainingBytes, expiresAt }
 *   DELETE {agent_url}/credentials  -> remove the EAP user + CoA-disconnect it
 *     body: { username }
 *   GET    {agent_url}/accounting   -> RADIUS accounting snapshot
 *     -> { sessions: [{ username, rxBytes, txBytes, lastSeen, assignedIp }] }
 *
 * Auth: header `X-Agent-Secret: <NODE_AGENT_SECRET>` (shared with the agent),
 * same as the WireGuard agent.
 */

const { requestJson } = require('./nodeHttp');

const NODE_AGENT_SECRET = process.env.NODE_AGENT_SECRET || '';
const TIMEOUT_MS = Number(process.env.NODE_AGENT_TIMEOUT_MS || 8000);

async function call(server, method, path, body) {
  if (!server.agent_url) {
    throw new Error(`server ${server.id} has provisioner='ikev2' but no agent_url`);
  }
  const url = `${server.agent_url.replace(/\/$/, '')}${path}`;
  const res = await requestJson(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Agent-Secret': NODE_AGENT_SECRET,
    },
    body: body == null ? null : JSON.stringify(body),
    timeoutMs: TIMEOUT_MS,
  });
  if (!res.ok) {
    throw new Error(`ikev2 agent ${server.id} ${method} ${path} -> ${res.status} ${res.text || ''}`);
  }
  return res.data ?? { ok: true };
}

async function addCredential({ server, username, password, remainingBytes, expiresAt }) {
  return call(server, 'POST', '/credentials', {
    username,
    password,
    // null => unlimited (premium); the agent arms no byte quota in that case.
    remainingBytes: remainingBytes == null ? null : Math.round(remainingBytes),
    expiresAt: expiresAt instanceof Date ? expiresAt.toISOString() : expiresAt || null,
  });
}

async function removeCredential({ server, username }) {
  return call(server, 'DELETE', '/credentials', { username });
}

/** Pull the RADIUS accounting snapshot for the usage poller. */
async function fetchAccounting({ server }) {
  const data = await call(server, 'GET', '/accounting', null);
  return Array.isArray(data.sessions) ? data.sessions : [];
}

module.exports = { addCredential, removeCredential, fetchAccounting };
