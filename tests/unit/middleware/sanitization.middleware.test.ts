/**
 * The global sanitizer runs before every route limiter. Strings without markup
 * skip the HTML parser (and must come out exactly as the parser returned them);
 * strings with markup are parsed within a per-client budget.
 */
import type { NextFunction, Request, Response } from 'express';

jest.mock('../../../src/utils/logDeduplicator', () => ({
  logDeduplicator: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('sanitize-html', () => {
  const real = jest.requireActual('sanitize-html');
  const actual = (real.default ?? real) as (...args: unknown[]) => string;
  return { __esModule: true, default: jest.fn((...args: unknown[]) => actual(...args)) };
});

import sanitizeHtml from 'sanitize-html';
import { sanitizeInput } from '../../../src/middleware/validation/sanitization.middleware';

const parser = sanitizeHtml as unknown as jest.Mock;

/** The sanitizer as it was before the fast path: every string through the HTML parser. */
function reference(str: string): string {
  const out = (sanitizeHtml as unknown as (s: string, o: object) => string)(str, {
    allowedTags: [],
    allowedAttributes: {},
    disallowedTagsMode: 'discard',
    textFilter: (text: string) => text.replace(/[\x00-\x1F\x7F-\x9F]/g, ''),
  });
  return out.replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
}

/** Deterministic PRNG (mulberry32): the same strings on every run. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomString(rand: () => number, alphabet: readonly string[], maxLen: number): string {
  const len = Math.floor(rand() * (maxLen + 1));
  let out = '';
  for (let i = 0; i < len; i++) out += alphabet[Math.floor(rand() * alphabet.length)];
  return out;
}

const PLAIN: readonly string[] = [
  'a', 'b', 'Z', '0', '9', ' ', ' ', '  ', '\t', '\n', '\r', '\r\n', '\x00', '\x01', '\x1f', '\x7f', '\x85', '\x9f',
  ' ', ' ', ' ', '﻿', '　', '"', "'", '/', '\\', ';', '#', '=', '-', '!', '?', '%', 'é', '中',
  '😀', '\ud83d', '\ude00', 'amp', 'lt', 'script',
];
const MARKUP: readonly string[] = [
  ...PLAIN, '<', '>', '&', '<', '&', '</', '<a', '<a>', '</a>', '<script>', '</script>', '<style>', '<!--', '-->', '&amp;', '&lt;',
  '&gt;', '&#x41;', '&#65;', '&#0;', '&copy', '&nbsp;', '&T', '<![CDATA[', ']]>', '<?', 'href="x"', '<textarea>', '<img src=x onerror=1>',
];

interface Outcome {
  req: Request;
  status: number | null;
  json: Record<string, unknown> | null;
  headers: Record<string, string>;
  next: boolean;
  /** True when the middleware answered or went on before returning (no slice left for a later turn). */
  sync: boolean;
}

let ipCounter = 0;
/** Runs the middleware on one request until it answers or calls next; each call is a new client unless `ip` is given. */
function run(
  input: { query?: Record<string, unknown>; params?: Record<string, string>; body?: unknown },
  ip?: string
): Promise<Outcome> {
  ipCounter += 1;
  const req = {
    query: input.query ?? {},
    params: input.params ?? {},
    body: input.body,
    ip: ip ?? `10.${(ipCounter >> 16) & 255}.${(ipCounter >> 8) & 255}.${ipCounter & 255}`,
  } as unknown as Request;
  return new Promise((resolve, reject) => {
    const result: Outcome = { req, status: null, json: null, headers: {}, next: false, sync: false };
    let returned = false;
    const settle = (): void => {
      result.sync = !returned;
      resolve(result);
    };
    const res = {
      status(code: number) {
        result.status = code;
        return res;
      },
      json(body: Record<string, unknown>) {
        result.json = body;
        settle();
        return res;
      },
      setHeader(name: string, value: string) {
        result.headers[name] = value;
        return res;
      },
    } as unknown as Response;
    const next: NextFunction = (error?: unknown) => {
      if (error) {
        reject(error);
        return;
      }
      result.next = true;
      settle();
    };
    sanitizeInput(req, res, next);
    returned = true;
  });
}

describe('sanitizeInput', () => {
  beforeEach(() => {
    parser.mockClear();
  });

  it('returns strings without markup exactly as the HTML parser did, without calling it', async () => {
    const rand = prng(20261111);
    const inputs = Array.from({ length: 20_000 }, () => randomString(rand, PLAIN, 24));
    inputs.push('', ' ', 'x'.repeat(5000), ` ${'y '.repeat(2000)}`, 'a  b', '\x00\x01', 'tab\there', 'line\nbreak');
    const expected = inputs.map(reference);
    parser.mockClear();

    const { req, next, sync } = await run({ body: { values: [...inputs] } });

    expect(next).toBe(true);
    expect(sync).toBe(true);
    expect(parser).not.toHaveBeenCalled();
    expect((req.body as { values: string[] }).values).toEqual(expected);
  });

  it('returns strings with markup exactly as before', async () => {
    const rand = prng(6);
    const inputs = Array.from({ length: 3_000 }, () => randomString(rand, MARKUP, 12)).filter((s) => /[<>&]/.test(s));
    inputs.push('Tom & Jerry', 'AT&T', 'a > b', '<b>bold</b> text', '<script>alert(1)</script>ok', '&lt;script&gt;', 'R&amp;D');
    const expected = inputs.map(reference);

    // In slices, each from a new client: the whole set is more than one client's window.
    const got: string[] = [];
    for (let i = 0; i < inputs.length; i += 200) {
      const { req, next } = await run({ body: { values: inputs.slice(i, i + 200) } });
      expect(next).toBe(true);
      got.push(...(req.body as { values: string[] }).values);
    }
    expect(got).toEqual(expected);
  });

  it('cleans the query, the route params and nested bodies', async () => {
    const { req, next, sync } = await run({
      query: { q: '  <b>pepe</b>  ', plain: ' a  b ', list: ['<i>kept</i>'] },
      params: { id: '<x>42' },
      body: { a: { b: [{ c: 'x<br>y' }, 'Tom &amp; Jerry'] }, n: 5, t: true, z: null },
    });
    expect(next).toBe(true);
    // A few strings with markup: done before the middleware returns, as before.
    expect(sync).toBe(true);
    // Non-string query values are left to the route's own validation, as before.
    expect(req.query).toEqual({ q: 'pepe', plain: 'a b', list: ['<i>kept</i>'] });
    expect(req.params).toEqual({ id: '42' });
    expect(req.body).toEqual({ a: { b: [{ c: 'xy' }, 'Tom & Jerry'] }, n: 5, t: true, z: null });
  });

  it('refuses a body that needs more parsing than a whole window, without parsing any of it', async () => {
    const { status, json, next } = await run({ body: Array.from({ length: 12_375 }, () => '<a>') });
    expect(next).toBe(false);
    expect(status).toBe(400);
    expect(json).toMatchObject({ code: 'INPUT_TOO_COMPLEX' });
    expect(parser).not.toHaveBeenCalled();
  });

  it('refuses one long string of markup the same way', async () => {
    const { status, next } = await run({ query: { q: '<'.repeat(40_000) } });
    expect(next).toBe(false);
    expect(status).toBe(400);
    expect(parser).not.toHaveBeenCalled();
  });

  it('accepts the largest legitimate body: 1,000 wallets whose names all carry markup', async () => {
    const wallets = Array.from({ length: 1_000 }, (_, i) => ({ address: `0x${i.toString(16).padStart(40, '0')}`, name: `P&L <3 fund ${i}` }));
    const { req, next, sync } = await run({ body: { wallets } });
    expect(next).toBe(true);
    // Parsed in slices: the event loop was given back on the way.
    expect(sync).toBe(false);
    expect(parser).toHaveBeenCalledTimes(1_000);
    const out = (req.body as { wallets: Array<{ address: string; name: string }> }).wallets;
    expect(out).toHaveLength(1_000);
    expect(out[7]).toEqual({ address: wallets[7].address, name: reference('P&L <3 fund 7') });
  });

  it('counts the parsing per client: a spent window answers 429 until it rolls over', async () => {
    const now = jest.spyOn(Date, 'now');
    try {
      now.mockReturnValue(1_800_000_000_000);
      // One unit a string: 700 strings twice fit the 1,536 of a window, a third time does not.
      const body = (): unknown => ({ values: Array.from({ length: 700 }, () => '<a>') });
      expect((await run({ body: body() }, '203.0.113.9')).next).toBe(true);
      expect((await run({ body: body() }, '203.0.113.9')).next).toBe(true);

      parser.mockClear();
      const refused = await run({ body: body() }, '203.0.113.9');
      expect(refused.next).toBe(false);
      expect(refused.status).toBe(429);
      expect(refused.headers['Retry-After']).toBe('10');
      expect(parser).not.toHaveBeenCalled();

      // Requests without markup are not concerned, and neither is another client.
      expect((await run({ body: { values: ['plain', 'text'] } }, '203.0.113.9')).next).toBe(true);
      expect((await run({ body: body() }, '203.0.113.10')).next).toBe(true);

      // An IPv6 client is its /64: another address of the same prefix shares the budget.
      expect((await run({ body: body() }, '2001:db8:1:2::1')).next).toBe(true);
      expect((await run({ body: body() }, '2001:db8:1:2:aaaa::2')).next).toBe(true);
      expect((await run({ body: body() }, '2001:db8:1:2:bbbb::3')).status).toBe(429);

      now.mockReturnValue(1_800_000_000_000 + 10_000);
      expect((await run({ body: body() }, '203.0.113.9')).next).toBe(true);
    } finally {
      now.mockRestore();
    }
  });

  it('leaves what is nested deeper than the depth guard untouched, as before', async () => {
    let deep: Record<string, unknown> = { v: ' <b>x</b> ' };
    for (let i = 0; i < 9; i++) deep = { d: deep };
    const { req, next } = await run({ body: deep });
    expect(next).toBe(true);
    let cursor = req.body as Record<string, unknown>;
    for (let i = 0; i < 9; i++) cursor = cursor.d as Record<string, unknown>;
    expect(cursor.v).toBe(' <b>x</b> ');
  });
});
