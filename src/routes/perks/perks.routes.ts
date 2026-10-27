import express, { Request, Response } from 'express';
import { marketRateLimiter, accountRateLimiter } from '../../middleware/apiRateLimiter';
import { validatePrivyToken } from '../../middleware/authMiddleware';
import { PERKS, type Perk } from '../../constants/perks';

/**
 * Partner offers for Liquid Terminal users. Everyone sees what each offer is;
 * the code and the link of a members offer only go to a signed-in user.
 */
const router = express.Router();

export type PublicPerk = Omit<Perk, 'cta' | 'code'> & { cta?: Perk['cta']; locked: boolean };

/** Offers still running at `now` (an offer runs through its `expires` day, UTC). */
export function livePerks(now: Date = new Date()): Perk[] {
  const today = now.toISOString().slice(0, 10);
  return PERKS.filter((p) => !p.expires || p.expires >= today);
}

/** What anyone may see: members offers lose their link and code. */
export function toPublic(p: Perk): PublicPerk {
  if (p.access === 'public') {
    const { code: _code, ...rest } = p;
    return { ...rest, locked: false };
  }
  const { cta: _cta, code: _code, ...rest } = p;
  return { ...rest, locked: true };
}

/** GET /perks/public → every running offer, members offers without link or code */
router.get('/public', marketRateLimiter, (_req: Request, res: Response) => {
  res.set('Cache-Control', 'public, max-age=300');
  res.json({ success: true, data: livePerks().map(toPublic) });
});

/** GET /perks (signed in) → every running offer, with links and codes */
router.get('/', marketRateLimiter, accountRateLimiter, validatePrivyToken, (_req: Request, res: Response) => {
  res.set('Cache-Control', 'private, no-store');
  res.json({ success: true, data: livePerks().map((p) => ({ ...p, locked: false })) });
});

export default router;
