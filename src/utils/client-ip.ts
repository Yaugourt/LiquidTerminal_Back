import { isIP } from 'net';

/**
 * Key for per-client budgets. An IPv6 host usually owns a whole /64 (and can
 * pick any address inside it), so keying on the full address hands one caller
 * 2^64 identities. IPv6 addresses collapse to their /64 prefix; IPv4 and
 * IPv4-mapped IPv6 (`::ffff:1.2.3.4`) stay per address.
 */
export function rateLimitKeyForIp(ip: string): string {
  const parsed = parseIpv6(ip);
  if (!parsed) return ip;
  if (!Array.isArray(parsed)) return parsed.v4;
  return `${parsed.slice(0, 4).join(':')}::/64`;
}

/**
 * The /48 an IPv6 address sits in, or undefined for IPv4 (and IPv4-mapped IPv6).
 *
 * A /64 is one subnet; a site (a company, a hosting customer, often a home) is
 * given a /56 or a /48, which holds 256 or 65,536 of them. Keyed by /64 alone,
 * whoever holds a /48 has 65,536 budgets. The budget of what the provider bills
 * counts the /48 as well, against a few clients' worth. (The request limiters do
 * not: see marketRateLimiter.)
 */
export function siteKeyForIp(ip: string): string | undefined {
  const parsed = parseIpv6(ip);
  if (!Array.isArray(parsed)) return undefined;
  return `${parsed.slice(0, 3).join(':')}::/48`;
}

/** The 8 groups of an IPv6 address (lower-case hex, no leading zeros); the IPv4 address of an IPv4-mapped one; undefined for anything else. */
function parseIpv6(ip: string): string[] | { v4: string } | undefined {
  const bare = ip.split('%')[0];
  if (isIP(bare) !== 6) return undefined;

  // A dotted tail (`::ffff:1.2.3.4`, `64:ff9b::1.2.3.4`) is the last two groups written as an IPv4 address.
  let text = bare.toLowerCase();
  const dotted = /^(.*:)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (dotted) {
    const [a, b, c, d] = dotted.slice(2).map(Number);
    text = `${dotted[1]}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, tail = ''] = text.split('::');
  const headGroups = head ? head.split(':') : [];
  const tailGroups = text.includes('::') && tail ? tail.split(':') : [];
  const missing = 8 - headGroups.length - tailGroups.length;
  const groups = (text.includes('::')
    ? [...headGroups, ...Array<string>(Math.max(0, missing)).fill('0'), ...tailGroups]
    : headGroups
  ).map((g) => (Number.parseInt(g, 16) || 0).toString(16));
  // IPv4-mapped, however it is written (`::ffff:1.2.3.4`, `::ffff:102:304`, `0:0:0:0:0:ffff:…`): the IPv4 client it is.
  if (groups.length === 8 && groups.slice(0, 5).every((g) => g === '0') && groups[5] === 'ffff') {
    const high = Number.parseInt(groups[6], 16);
    const low = Number.parseInt(groups[7], 16);
    return { v4: `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}` };
  }
  return groups;
}
