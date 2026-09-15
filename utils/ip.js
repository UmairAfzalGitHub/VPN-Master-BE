'use strict';

/**
 * IPv4 pool math for allocating per-peer tunnel addresses out of a node's
 * `tunnel_subnet` (e.g. "10.7.0.0/16").
 *
 * Address .0 (network) and .1 (reserved for the server itself) are never
 * handed out; allocation starts at host offset 2.
 */

const SERVER_HOST_OFFSET = 1; // <subnet>.1 belongs to the wg interface
const FIRST_CLIENT_OFFSET = 2;

/** "10.7.0.23" -> 168427543 (unsigned 32-bit). */
function ipToInt(ip) {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) {
    throw new Error(`Invalid IPv4 address: ${ip}`);
  }
  return ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
}

/** 168427543 -> "10.7.0.23". */
function intToIp(int) {
  return [
    (int >>> 24) & 0xff,
    (int >>> 16) & 0xff,
    (int >>> 8) & 0xff,
    int & 0xff,
  ].join('.');
}

/**
 * Parse a CIDR like "10.7.0.0/16" into { networkInt, prefix, size } where
 * `size` is the total number of addresses in the block.
 */
function parseCidr(cidr) {
  const [base, prefixStr] = String(cidr).split('/');
  const prefix = Number(prefixStr);
  if (!base || Number.isNaN(prefix) || prefix < 0 || prefix > 32) {
    throw new Error(`Invalid CIDR: ${cidr}`);
  }
  const baseInt = ipToInt(base);
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  const networkInt = (baseInt & mask) >>> 0;
  const size = 2 ** (32 - prefix);
  return { networkInt, prefix, size };
}

/**
 * Pick the lowest free host address in `cidr` that is not in `usedIps`.
 *
 * @param {string} cidr        e.g. "10.7.0.0/16"
 * @param {Set<string>|string[]} usedIps  already-allocated host addresses
 * @param {number} [maxHosts]  optional cap (mirrors servers.max_peers)
 * @returns {string|null}      the free "10.7.0.23" host, or null if exhausted
 */
function allocateAddress(cidr, usedIps, maxHosts) {
  const used = usedIps instanceof Set ? usedIps : new Set(usedIps);
  const { networkInt, size } = parseCidr(cidr);

  // Last address in the block is the broadcast; never allocate it.
  const lastOffset = size - 2;
  const cap = maxHosts ? Math.min(lastOffset, FIRST_CLIENT_OFFSET + maxHosts - 1) : lastOffset;

  for (let offset = FIRST_CLIENT_OFFSET; offset <= cap; offset += 1) {
    const candidate = intToIp((networkInt + offset) >>> 0);
    if (!used.has(candidate)) return candidate;
  }
  return null; // pool exhausted
}

module.exports = {
  ipToInt,
  intToIp,
  parseCidr,
  allocateAddress,
  SERVER_HOST_OFFSET,
  FIRST_CLIENT_OFFSET,
};
