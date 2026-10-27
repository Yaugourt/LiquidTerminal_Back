import express, { Request, Response, RequestHandler } from 'express';
import { z } from 'zod';
import { addressLookupRateLimiter, marketRateLimiter, namesWriteRateLimiter } from '../../middleware/apiRateLimiter';
import { logDeduplicator } from '../../utils/logDeduplicator';
import { HlNamesClient, HL_NAME_RE } from '../../clients/hlnames/hlnames.client';

/**
 * Hyperliquid Names (.hl) for the site: batch reverse lookup for address
 * lists, forward resolution for search, and a profile for wallet headers.
 * Public data, cached server-side (see HlNamesClient). Also hands out the
 * signed mint passes for minting a name on the site.
 */
const router = express.Router();
const names = HlNamesClient.getInstance();
router.use(marketRateLimiter);

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const batchSchema = z.object({ addresses: z.array(z.string().regex(ADDRESS)).min(1).max(500) }).strict();

const unavailable = (res: Response, context: string, error: unknown) => {
  logDeduplicator.warn(context, { error: error instanceof Error ? error.message : String(error) });
  res.status(502).json({ success: false, error: 'Name service unavailable', code: 'UPSTREAM_UNAVAILABLE' });
};

/** POST /names/primary { addresses } → { "0x…": "name.hl" | null } (unknown addresses omitted) */
router.post('/primary', (async (req: Request, res: Response) => {
  const parsed = batchSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ success: false, error: 'addresses: 1 to 500 EVM addresses', code: 'VALIDATION_ERROR' });
  try {
    res.set('Cache-Control', 'public, max-age=300');
    res.json({ success: true, data: await names.primaryNames(parsed.data.addresses) });
  } catch (error) {
    unavailable(res, 'names/primary failed', error);
  }
}) as RequestHandler);

/** GET /names/resolve/:name → { name, address | null } */
router.get('/resolve/:name', (async (req: Request, res: Response) => {
  const name = String(req.params.name).toLowerCase();
  if (!HL_NAME_RE.test(name) || name.length > 100) return res.status(400).json({ success: false, error: 'Not a .hl name', code: 'VALIDATION_ERROR' });
  try {
    res.set('Cache-Control', 'public, max-age=300');
    res.json({ success: true, data: { name, address: await names.resolve(name) } });
  } catch (error) {
    unavailable(res, 'names/resolve failed', error);
  }
}) as RequestHandler);

/** GET /names/profile/:address → { address, name, avatar, records } */
router.get('/profile/:address', (async (req: Request, res: Response) => {
  const address = String(req.params.address);
  if (!ADDRESS.test(address)) return res.status(400).json({ success: false, error: 'Not an address', code: 'VALIDATION_ERROR' });
  try {
    res.set('Cache-Control', 'public, max-age=300');
    res.json({ success: true, data: await names.profile(address) });
  } catch (error) {
    unavailable(res, 'names/profile failed', error);
  }
}) as RequestHandler);

/** GET /names/owned/:address → [{ name, expiry }] names the address holds */
router.get('/owned/:address', addressLookupRateLimiter, (async (req: Request, res: Response) => {
  const address = String(req.params.address);
  if (!ADDRESS.test(address)) return res.status(400).json({ success: false, error: 'Not an address', code: 'VALIDATION_ERROR' });
  try {
    res.set('Cache-Control', 'public, max-age=60');
    res.json({ success: true, data: await names.ownedNames(address) });
  } catch (error) {
    unavailable(res, 'names/owned failed', error);
  }
}) as RequestHandler);

/** GET /names/card-template → { svg } the NFT card the mint page fills with a name */
router.get('/card-template', (async (_req: Request, res: Response) => {
  try {
    res.set('Cache-Control', 'public, max-age=3600');
    res.json({ success: true, data: { svg: await names.cardTemplate() } });
  } catch (error) {
    unavailable(res, 'names/card-template failed', error);
  }
}) as RequestHandler);

/** A label as the Minter takes it: already ENS-normalized by the client, 1 to 30 characters, no dot or space. */
const LABEL = /^[^\s./?#%]{1,30}$/u;
const mintPassSchema = z.object({ token: z.enum(['native', 'usdc']).default('native') }).strict();

/** POST /names/mintpass/:label { token } → signed Minter arguments, valid about 60s */
router.post('/mintpass/:label', namesWriteRateLimiter, (async (req: Request, res: Response) => {
  const label = String(req.params.label);
  const body = mintPassSchema.safeParse(req.body ?? {});
  if (!LABEL.test(label) || [...label].length > 30 || !body.success) {
    return res.status(400).json({ success: false, error: 'Invalid label or token', code: 'VALIDATION_ERROR' });
  }
  try {
    res.set('Cache-Control', 'no-store');
    res.json({ success: true, data: await names.mintPass(label, body.data.token) });
  } catch (error) {
    unavailable(res, 'names/mintpass failed', error);
  }
}) as RequestHandler);

/** POST /names/forget/:address → drops cached name data so a fresh mint shows up */
router.post('/forget/:address', namesWriteRateLimiter, (async (req: Request, res: Response) => {
  const address = String(req.params.address);
  if (!ADDRESS.test(address)) return res.status(400).json({ success: false, error: 'Not an address', code: 'VALIDATION_ERROR' });
  await names.forget(address).catch(() => undefined);
  res.set('Cache-Control', 'no-store');
  res.json({ success: true });
}) as RequestHandler);

export default router;
