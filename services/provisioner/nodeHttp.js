'use strict';

const fs = require('fs');
const path = require('path');
const http = require('node:http');
const https = require('node:https');

/**
 * Minimal JSON HTTP(S) client for node-agent calls.
 *
 * Why not global `fetch`: the node agents serve a self-signed cert (SAN = node
 * IP, no domain — see node-agent/README "TLS"). We trust those certs by loading
 * the committed PUBLIC certs under `certs/` and passing them as `ca`. Doing it
 * through the built-in `https` module works on ANY Node version, unlike
 * `NODE_EXTRA_CA_CERTS` + `fetch` (only honored on Node ≥ 20.6). The trust is
 * scoped to these calls, so nothing else's TLS is affected.
 *
 * `http://` agent_urls keep working unchanged (the `ca` is simply ignored).
 */

function loadNodeCAs() {
  const dir = path.join(__dirname, '..', '..', 'certs');
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.crt') || f.endsWith('.pem'))
      .map((f) => fs.readFileSync(path.join(dir, f)));
  } catch (_err) {
    return []; // no certs dir yet — https to a self-signed node will fail, as expected
  }
}

const NODE_CAS = loadNodeCAs();

/**
 * @returns {Promise<{ ok: boolean, status: number, text: string, data: any }>}
 */
function requestJson(urlStr, { method = 'GET', headers = {}, body = null, timeoutMs = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(urlStr);
    } catch (err) {
      return reject(err);
    }

    const isHttps = url.protocol === 'https:';
    const lib = isHttps ? https : http;
    const options = { method, headers: { ...headers } };
    if (isHttps && NODE_CAS.length) options.ca = NODE_CAS;
    if (body != null) options.headers['Content-Length'] = Buffer.byteLength(body);

    const req = lib.request(url, options, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        clearTimeout(timer);
        const text = Buffer.concat(chunks).toString('utf8');
        let data;
        try {
          data = text ? JSON.parse(text) : undefined;
        } catch (_e) {
          data = undefined;
        }
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, text, data });
      });
    });

    const timer = setTimeout(() => req.destroy(new Error(`request timed out after ${timeoutMs}ms`)), timeoutMs);
    req.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    if (body != null) req.write(body);
    req.end();
  });
}

module.exports = { requestJson, NODE_CAS };
