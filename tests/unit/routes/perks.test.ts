/**
 * The public perks list must never carry a members offer's link or code.
 */
jest.mock('../../../src/middleware/apiRateLimiter', () => ({
  marketRateLimiter: jest.fn(),
  accountRateLimiter: jest.fn(),
}));
jest.mock('../../../src/middleware/authMiddleware', () => ({ validatePrivyToken: jest.fn() }));

import { toPublic, livePerks } from '../../../src/routes/perks/perks.routes';
import { PERKS, type Perk } from '../../../src/constants/perks';

const members: Perk = {
  id: 'm',
  partner: 'P',
  partnerUrl: 'https://p.example',
  title: 't',
  description: 'd',
  access: 'members',
  cta: { label: 'Use', href: 'https://p.example/secret' },
  code: 'SECRET',
};

describe('perks', () => {
  it('strips link and code from a members offer', () => {
    const p = toPublic(members);
    expect(p).not.toHaveProperty('code');
    expect(p).not.toHaveProperty('cta');
    expect(JSON.stringify(p)).not.toContain('SECRET');
    expect(JSON.stringify(p)).not.toContain('/secret');
    expect(p.locked).toBe(true);
  });

  it('keeps the link of a public offer but never a code', () => {
    const p = toPublic({ ...members, access: 'public' });
    expect(p.cta?.href).toBe('https://p.example/secret');
    expect(p).not.toHaveProperty('code');
    expect(p.locked).toBe(false);
  });

  it('serves an offer through its last day and drops it after', () => {
    PERKS.push({ ...members, id: 'exp', expires: '2026-10-27' });
    try {
      expect(livePerks(new Date('2026-10-27T23:59:00Z')).some((p) => p.id === 'exp')).toBe(true);
      expect(livePerks(new Date('2026-10-28T00:00:00Z')).some((p) => p.id === 'exp')).toBe(false);
    } finally {
      PERKS.pop();
    }
  });

  it('only lists offers with an internal route or an https link', () => {
    for (const p of PERKS) {
      expect(p.cta.href.startsWith('/') || p.cta.href.startsWith('https://')).toBe(true);
      expect(p.partnerUrl.startsWith('https://')).toBe(true);
    }
  });
});
