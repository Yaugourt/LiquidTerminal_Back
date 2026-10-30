/**
 * Contexts pushed by the socket are laid over the last REST read:
 * - spot by coin: the '#' HIP-4 outcome entries and coins the socket has not
 *   sent stay as REST read them;
 * - perp by universe position: delisted perps stay as read;
 * - a pushed context older than the REST read does not replace it;
 * - neither input is modified, entries keep REST's field order.
 */
import { mergeSpotContexts } from '../../../src/clients/hyperliquid/spot/spot.assembler';
import { mergePerpContexts } from '../../../src/clients/hyperliquid/perp/perp.assembler';
import type { LiveCtx } from '../../../src/clients/hyperliquid/websocket/asset-ctx.ws.client';
import type { AssetContext, PerpAssetContext } from '../../../src/types/market.types';

const REST_AT = 1_000;
const live = (entries: Record<string, Record<string, unknown>>, at = REST_AT + 500): Map<string, LiveCtx> =>
  new Map(Object.entries(entries).map(([coin, ctx]) => [coin, { ctx, at }]));

describe('mergeSpotContexts', () => {
  const rest = [
    { prevDayPx: '1.0', dayNtlVlm: '10.0', markPx: '1.1', midPx: '1.1', circulatingSupply: '100', coin: 'PURR/USDC', totalSupply: '200', dayBaseVlm: '5' },
    { prevDayPx: '2.0', dayNtlVlm: '20.0', markPx: '2.1', midPx: '2.1', circulatingSupply: '300', coin: '@107', totalSupply: '400', dayBaseVlm: '6' },
    { prevDayPx: '0.5', dayNtlVlm: '0.0', markPx: '0.5', midPx: '0.5', circulatingSupply: '0', coin: '#90', totalSupply: '0', dayBaseVlm: '0' },
    { prevDayPx: '3.0', dayNtlVlm: '30.0', markPx: '3.1', midPx: '3.1', circulatingSupply: '500', coin: '@142', totalSupply: '600', dayBaseVlm: '7' },
  ] as AssetContext[];

  it('replaces the values of the coins the socket pushed, in REST order and field order', () => {
    const merged = mergeSpotContexts(
      rest,
      live({ '@107': { markPx: '2.5', midPx: '2.4', dayNtlVlm: '25.0', prevDayPx: '2.0', circulatingSupply: '301', coin: '@107', totalSupply: '401', dayBaseVlm: '9' } }),
      REST_AT
    );
    expect(merged.map((c) => c.coin)).toEqual(['PURR/USDC', '@107', '#90', '@142']);
    expect(merged[1]).toEqual({ prevDayPx: '2.0', dayNtlVlm: '25.0', markPx: '2.5', midPx: '2.4', circulatingSupply: '301', coin: '@107', totalSupply: '401', dayBaseVlm: '9' });
    expect(Object.keys(merged[1])).toEqual(Object.keys(rest[1]));
  });

  it("keeps the HIP-4 '#' entries and the coins the socket did not send", () => {
    const merged = mergeSpotContexts(rest, live({ '@107': { markPx: '9.9' } }), REST_AT);
    expect(merged[0]).toBe(rest[0]);
    expect(merged[2]).toBe(rest[2]);
    expect(merged[3]).toBe(rest[3]);
    expect(merged).toHaveLength(rest.length);
  });

  it('does not add coins the REST read does not list', () => {
    expect(mergeSpotContexts(rest, live({ '@999': { markPx: '1' } }), REST_AT)).toHaveLength(4);
  });

  it('ignores a pushed context older than the REST read', () => {
    const merged = mergeSpotContexts(rest, live({ '@107': { markPx: '9.9' } }, REST_AT - 1), REST_AT);
    expect(merged[1]).toBe(rest[1]);
  });

  it('does not modify its inputs', () => {
    const before = JSON.stringify(rest);
    const pushed = live({ '@107': { markPx: '9.9' } });
    const pushedBefore = JSON.stringify([...pushed]);
    mergeSpotContexts(rest, pushed, REST_AT);
    expect(JSON.stringify(rest)).toBe(before);
    expect(JSON.stringify([...pushed])).toBe(pushedBefore);
  });
});

describe('mergePerpContexts', () => {
  const meta = {
    universe: [
      { name: 'BTC', szDecimals: 5, maxLeverage: 40 },
      { name: 'DEAD', szDecimals: 1, maxLeverage: 3, isDelisted: true },
      { name: 'ETH', szDecimals: 4, maxLeverage: 25 },
    ],
  };
  const ctx = (markPx: string, funding: string): PerpAssetContext => ({
    funding,
    openInterest: '10',
    prevDayPx: '1',
    dayNtlVlm: '100',
    premium: '0',
    oraclePx: markPx,
    markPx,
    midPx: markPx,
    impactPxs: [markPx, markPx],
    dayBaseVlm: '3',
  } as PerpAssetContext);
  const rest = [ctx('80000', '0.0001'), ctx('1', '0'), ctx('4000', '0.0002')];

  it('matches pushed contexts to the universe by position', () => {
    const merged = mergePerpContexts(meta, rest, live({ ETH: { markPx: '4100', funding: '0.0003' } }), REST_AT);
    expect(merged[2]).toMatchObject({ markPx: '4100', funding: '0.0003', openInterest: '10' });
    expect(Object.keys(merged[2])).toEqual(Object.keys(rest[2]));
    expect(merged[0]).toBe(rest[0]);
    expect(merged[1]).toBe(rest[1]);
  });

  it('keeps a delisted perp (never subscribed, so never pushed) as REST read it', () => {
    const merged = mergePerpContexts(meta, rest, live({ BTC: { markPx: '81000' } }), REST_AT);
    expect(merged[0].markPx).toBe('81000');
    expect(merged[1]).toBe(rest[1]);
  });

  it('ignores a pushed context older than the REST read and leaves the inputs alone', () => {
    const before = JSON.stringify(rest);
    const merged = mergePerpContexts(meta, rest, live({ BTC: { markPx: '81000' } }, REST_AT), REST_AT);
    expect(merged[0]).toBe(rest[0]);
    expect(JSON.stringify(rest)).toBe(before);
  });

  it('keeps the REST length when the universe is shorter than the contexts', () => {
    const merged = mergePerpContexts({ universe: [meta.universe[0]] }, rest, live({ BTC: { markPx: '81000' } }), REST_AT);
    expect(merged).toHaveLength(3);
    expect(merged[0].markPx).toBe('81000');
    expect(merged[2]).toBe(rest[2]);
  });
});
