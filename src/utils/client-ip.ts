import { isIP } from 'net';

/**
 * Key for per-client budgets. An IPv6 host usually owns a whole /64 (and can
 * pick any address inside it), so keying on the full address hands one caller
 * 2^64 identities. IPv6 addresses collapse to their /64 prefix; IPv4 and
 * IPv4-mapped IPv6 (`::ffff:1.2.3.4`) stay per address.
 */
export function rateLimitKeyForIp(ip: string): string {
  const groups = ipv6Groups(ip);
  if (groups === 'v4-mapped') return /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(ip.split('%')[0])?.[1] ?? ip;
  if (!groups) return ip;
  return `${groups.slice(0, 4).join(':')}::/64`;
}

/**
 * The /48 an IPv6 address sits in, or undefined for IPv4 (and IPv4-mapped IPv6).
 *
 * A /64 is one subnet; a site (a company, a hosting customer, often a home) is
 * given a /56 or a /48, which holds 256 or 65,536 of them. Keyed by /64 alone,
 * whoever holds a /48 has 65,536 budgets. The limiters count the /48 as well,
 * against a multiple of the per-client limit: wide enough for the many people a
 * carrier can put in one /48, and no longer one budget per subnet.
 */
export function siteKeyForIp(ip: string): string | undefined {
  const groups = ipv6Groups(ip);
  if (!groups || groups === 'v4-mapped') return undefined;
  return `${groups.slice(0, 3).join(':')}::/48`;
}

/** The 8 groups of an IPv6 address (lower-case hex, no leading zeros); 'v4-mapped' for `::ffff:1.2.3.4`; undefined for anything else. */
function ipv6Groups(ip: string): string[] | 'v4-mapped' | undefined {
  const bare = ip.split('%')[0];
  if (/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.test(bare)) return 'v4-mapped';
  if (isIP(bare) !== 6) return undefined;

  const [head, tail = ''] = bare.toLowerCase().split('::');
  const headGroups = head ? head.split(':') : [];
  const tailGroups = bare.includes('::') && tail ? tail.split(':') : [];
  const missing = 8 - headGroups.length - tailGroups.length;
  const groups = bare.includes('::')
    ? [...headGroups, ...Array<string>(Math.max(0, missing)).fill('0'), ...tailGroups]
    : headGroups;
  return groups.map((g) => (Number.parseInt(g, 16) || 0).toString(16));
}
