import { NextFunction, Request, Response } from 'express';
import { ClientBudget } from '../utils/clientBudget';
import { rateLimitKeyForIp } from '../utils/client-ip';
import { positiveIntEnv } from '../utils/env';
import { logDeduplicator } from '../utils/logDeduplicator';
import { BODY_PARSER_LIMIT_BYTES } from './bodyParsers.middleware';

/** What a request with a body weighs at least: parsing has a floor, whatever the size. */
const MIN_BODY_COST_BYTES = 1024;

/**
 * Bytes of JSON / form bodies one client may hand to the global parsers.
 *
 * The parsers and the sanitizer run before any route, so before any route
 * limiter: a POST to a path that does not exist was parsed, walked and never
 * counted. Reading and walking a 100 kB body takes a few milliseconds of the
 * event loop, and at the general limiter's 200 requests a second that was most
 * of a core for one client.
 *
 * Sizing: the busiest legitimate sender is the Elysium RPC proxy, 50 calls a
 * second and 1,200 a minute per client, a few hundred bytes each (counted at
 * the 1 kB floor): 50 kB a second, 1.2 MB a minute. The largest single body is
 * a bulk wallet import, up to the parser's 100 kB. 512 kB a second and 8 MB a
 * minute leave both several times their need.
 */
const perSecond = new ClientBudget(positiveIntEnv('BODY_BYTES_PER_SECOND', 512 * 1024), 1_000);
const perMinute = new ClientBudget(positiveIntEnv('BODY_BYTES_PER_MINUTE', 8 * 1024 * 1024), 60_000);

/**
 * What the global parsers will read for this request, in bytes; 0 when they
 * will not read anything (no body, or a type they skip: uploads go through
 * multer on their own routes, with their own limits).
 */
function bodyCost(req: Request): number {
  // Same test as the parsers: `req.is` is false without a body or for another type.
  if (!req.is('application/json') && !req.is('application/x-www-form-urlencoded')) return 0;
  // No declared length (chunked): the parser reads up to its limit, so that is what is counted.
  if (req.headers['transfer-encoding'] !== undefined) return BODY_PARSER_LIMIT_BYTES;
  const declared = Number(req.headers['content-length']);
  if (!Number.isFinite(declared)) return BODY_PARSER_LIMIT_BYTES;
  // Over the limit the parser answers 413 without reading the body.
  if (declared > BODY_PARSER_LIMIT_BYTES) return MIN_BODY_COST_BYTES;
  return Math.max(MIN_BODY_COST_BYTES, declared);
}

/**
 * Mounted before the body parsers: counts the body against its client (per
 * address, per /64 for IPv6) and answers 429 with Retry-After past the budget,
 * before a byte of it is parsed. In memory, so it holds when Redis is down.
 */
export function requestBodyBudget(req: Request, res: Response, next: NextFunction): void {
  const cost = bodyCost(req);
  if (cost === 0) {
    next();
    return;
  }
  const key = rateLimitKeyForIp(req.ip ?? '');
  const now = Date.now();
  const refusedBy =
    perSecond.remaining(key, now) < cost ? perSecond : perMinute.remaining(key, now) < cost ? perMinute : null;
  if (refusedBy) {
    const retryAfter = refusedBy.retryAfterS(now);
    logDeduplicator.warn('Request body budget spent', { ip: key, window: refusedBy === perSecond ? 'second' : 'minute' });
    // The body is left unread: Node drains it off the socket once the response is out.
    res.setHeader('Retry-After', String(retryAfter));
    res.status(429).json({ error: 'Rate limit exceeded', message: 'Too many request bodies', retryAfter });
    return;
  }
  perSecond.take(key, cost, now);
  perMinute.take(key, cost, now);
  next();
}
