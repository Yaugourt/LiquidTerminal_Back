import { lookup } from 'dns/promises';
import { isIP, isIPv4 } from 'net';
import { SSRF_BLOCKED_CIDRS_V4, SSRF_BLOCKED_CIDRS_V6 } from '../constants/security.constants';

function ipv4ToInt(ip: string): number {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) {
    throw new Error(`Invalid IPv4: ${ip}`);
  }
  return ((parts[0] << 24) >>> 0) + ((parts[1] << 16) >>> 0) + ((parts[2] << 8) >>> 0) + parts[3];
}

function parseV4Cidr(cidr: string): { base: number; mask: number } {
  const [ip, bitsStr] = cidr.split('/');
  const bits = Number(bitsStr);
  const base = ipv4ToInt(ip);
  const mask = bits === 0 ? 0 : (~((1 << (32 - bits)) - 1)) >>> 0;
  return { base: (base & mask) >>> 0, mask };
}

function isV4InCidr(ip: string, cidr: string): boolean {
  const { base, mask } = parseV4Cidr(cidr);
  return ((ipv4ToInt(ip) & mask) >>> 0) === base;
}

function ipv6ToBytes(ip: string): Uint8Array {
  // Minimal IPv6 expander; supports `::` zero-run and IPv4-in-IPv6 forms.
  const s = ip.toLowerCase().split('%')[0]; // strip zone id
  const doubleColonIdx = s.indexOf('::');
  let head: string[];
  let tail: string[];
  if (doubleColonIdx >= 0) {
    const [h, t] = s.split('::');
    head = h ? h.split(':') : [];
    tail = t ? t.split(':') : [];
  } else {
    head = s.split(':');
    tail = [];
  }
  // Expand a trailing embedded IPv4 (e.g. ::ffff:1.2.3.4) into two hextets.
  const expandIPv4 = (groups: string[]): string[] => {
    if (groups.length === 0) return groups;
    const last = groups[groups.length - 1];
    if (last.includes('.') && isIPv4(last)) {
      const v4 = last.split('.').map((n) => parseInt(n, 10));
      const hex1 = (((v4[0] << 8) | v4[1]) >>> 0).toString(16);
      const hex2 = (((v4[2] << 8) | v4[3]) >>> 0).toString(16);
      return [...groups.slice(0, -1), hex1, hex2];
    }
    return groups;
  };
  head = expandIPv4(head);
  tail = expandIPv4(tail);
  const missing = 8 - (head.length + tail.length);
  if (missing < 0) throw new Error(`Invalid IPv6: ${ip}`);
  const groups = [...head, ...Array(missing).fill('0'), ...tail];
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    const v = parseInt(groups[i] || '0', 16);
    if (Number.isNaN(v)) throw new Error(`Invalid IPv6 group: ${groups[i]} in ${ip}`);
    bytes[i * 2] = (v >> 8) & 0xff;
    bytes[i * 2 + 1] = v & 0xff;
  }
  return bytes;
}

function isV6InCidr(ip: string, cidr: string): boolean {
  const [base, bitsStr] = cidr.split('/');
  const bits = Number(bitsStr);
  const ipBytes = ipv6ToBytes(ip);
  const baseBytes = ipv6ToBytes(base);
  const fullBytes = Math.floor(bits / 8);
  for (let i = 0; i < fullBytes; i++) {
    if (ipBytes[i] !== baseBytes[i]) return false;
  }
  const remBits = bits % 8;
  if (remBits === 0) return true;
  const mask = (0xff << (8 - remBits)) & 0xff;
  return (ipBytes[fullBytes] & mask) === (baseBytes[fullBytes] & mask);
}

/**
 * True if `ip` (literal v4 or v6 string) is in one of the SSRF blocklists.
 * Throws on a string that is not a literal IP address.
 */
export function isBlockedIp(ip: string): boolean {
  const family = isIP(ip);
  if (family === 0) {
    throw new Error(`Not an IP literal: ${ip}`);
  }
  const cidrs = family === 4 ? SSRF_BLOCKED_CIDRS_V4 : SSRF_BLOCKED_CIDRS_V6;
  const checker = family === 4 ? isV4InCidr : isV6InCidr;
  return cidrs.some((cidr) => checker(ip, cidr));
}

/**
 * Resolves the hostname and asserts none of the resolved addresses fall in
 * the SSRF blocklist. Returns the resolved address that should be used to
 * connect, OR throws if blocked / unresolvable.
 *
 * Caller responsibility: re-run this check on every redirect, since each hop
 * resolves to a fresh hostname.
 */
export async function assertHostnameNotBlocked(hostname: string): Promise<void> {
  // Reject IP literals in URLs that are already blocked, no DNS needed.
  if (isIP(hostname) !== 0) {
    if (isBlockedIp(hostname)) {
      throw new SsrfBlockedError(`Refused to connect to blocked address: ${hostname}`);
    }
    return;
  }
  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = await lookup(hostname, { all: true });
  } catch (err) {
    throw new SsrfBlockedError(
      `DNS resolution failed for ${hostname}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  for (const addr of addresses) {
    if (isBlockedIp(addr.address)) {
      throw new SsrfBlockedError(
        `Refused to connect to ${hostname}: resolved address ${addr.address} is blocked`,
      );
    }
  }
}

export class SsrfBlockedError extends Error {
  public readonly code = 'SSRF_BLOCKED';
  constructor(message: string) {
    super(message);
    this.name = 'SsrfBlockedError';
  }
}
