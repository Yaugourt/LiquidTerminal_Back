import { rateLimitKeyForIp, siteKeyForIp } from '../../../src/utils/client-ip';

describe('the key a client is counted under', () => {
  it('is the address for IPv4', () => {
    expect(rateLimitKeyForIp('203.0.113.9')).toBe('203.0.113.9');
    expect(siteKeyForIp('203.0.113.9')).toBeUndefined();
  });

  it('is the IPv4 address for an IPv4-mapped IPv6 one, however it is written', () => {
    for (const ip of ['::ffff:9.9.9.9', '::FFFF:9.9.9.9', '::ffff:909:909', '0:0:0:0:0:ffff:9.9.9.9', '0000:0000:0000:0000:0000:ffff:0909:0909']) {
      expect(rateLimitKeyForIp(ip)).toBe('9.9.9.9');
      expect(siteKeyForIp(ip)).toBeUndefined();
    }
  });

  it('is the /64 for IPv6, with the /48 it sits in, whatever the case, the zeros or the zone', () => {
    for (const ip of ['2001:db8:1:2::1', '2001:0DB8:0001:0002:ffff:ffff:ffff:ffff', '2001:db8:1:2:a:b:c:d%eth0']) {
      expect(rateLimitKeyForIp(ip)).toBe('2001:db8:1:2::/64');
      expect(siteKeyForIp(ip)).toBe('2001:db8:1::/48');
    }
    expect(rateLimitKeyForIp('2001:db8:1:3::1')).toBe('2001:db8:1:3::/64');
    expect(siteKeyForIp('2001:db8:2::1')).toBe('2001:db8:2::/48');
  });

  it('keeps an IPv6 address that embeds an IPv4 one without being mapped (NAT64, 6to4) as IPv6', () => {
    expect(rateLimitKeyForIp('64:ff9b::1.2.3.4')).toBe('64:ff9b:0:0::/64');
    expect(siteKeyForIp('2002:102:304::1')).toBe('2002:102:304::/48');
  });

  it('leaves what is not an address as it is', () => {
    expect(rateLimitKeyForIp('not-an-ip')).toBe('not-an-ip');
    expect(rateLimitKeyForIp('')).toBe('');
    expect(siteKeyForIp('not-an-ip')).toBeUndefined();
  });
});
