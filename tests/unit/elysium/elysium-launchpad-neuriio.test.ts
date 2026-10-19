import {
  decodeGraduation,
  decodeLaunch,
  decodeLaunchTrade,
  LaunchMarket,
  launchMarketKeys,
  NEURIIO_USDC,
  NEURIIO_WHYPE,
} from '../../../src/services/elysium/elysium-launchpad.util';

/** Real Neuriio logs from the Elysium testnet (RPC receipts in the upstream /logs shape); block_time is fixed. */
/** Launched on the HYPE-priced pad 0xd994...5e59. */
const hypeLaunch = {
  block_time: '2026-10-01T00:00:00',
  block_number: 5377064,
  log_index: 3,
  tx_hash: '0xa8868fa0d372a75d8e6854e1cd2122f13cc5e5249088158c5896b19e9b6af308',
  address: '0xd9943d81b72aa55e52580bbb595af797b04d5e59',
  topic0: '0x096478a529366552bb1b4db7668203cf0d554c786f86c20059967309f535ab06',
  topic1: '0x000000000000000000000000e37c75b2fcfff1d3ac963552a556e6b78b6d5137',
  topic2: '0x000000000000000000000000f1aecc201d3eeb695c0f4409dbb5e01005e8e2ae',
  topic3: '0x00000000000000000000000000000000000000000000000000000000142f5f2f',
  data: '0x000000000000000000000000000000000000000000000000000000000000008000000000000000000000000000000000000000000000000000000000000000003f09d6c36748a716e2cfd2d3837011332e066677d9ba5e14e5223805b644c588000000000000000000000000000000000000000000000000016345785d8a00000000000000000000000000000000000000000000000000000000000000000006766f6e5f686c0000000000000000000000000000000000000000000000000000',
};
/** First curve trade of that token. */
const hypeTrade = {
  block_time: '2026-10-01T00:00:00',
  block_number: 5377143,
  log_index: 1,
  tx_hash: '0x4aa10587579418acd4328919447ee884510c2109651ad2b86f682615d906f70c',
  address: '0xd9943d81b72aa55e52580bbb595af797b04d5e59',
  topic0: '0x2c76e7a47fd53e2854856ac3f0a5f3ee40d15cfaa82266357ea9779c486ab9c3',
  topic1: '0x000000000000000000000000e37c75b2fcfff1d3ac963552a556e6b78b6d5137',
  topic2: '0x000000000000000000000000f1aecc201d3eeb695c0f4409dbb5e01005e8e2ae',
  topic3: '',
  data: '0x00000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000160a06d4e3b7955000000000000000000000000000000000000000001ba1fdac6c9792588294c0c0000000000000000000000000000000000000000000000000002a50b0f4e86ab00000000000000000000000000000000000000000000000002c3e5e5abc57955000000000000000000000000000000000000000001bd70bbc6ff76da48d6b3f4',
};
/** Its graduation into a TOKEN/WHYPE pair. */
const hypeGraduated = {
  block_time: '2026-10-01T00:00:00',
  block_number: 5377201,
  log_index: 14,
  tx_hash: '0x064c05556d9d619fcd940cb04efabfbce8e3c08c486ae337eefbdd0258762ac8',
  address: '0xd9943d81b72aa55e52580bbb595af797b04d5e59',
  topic0: '0x487dc7f66c623fb0ff13f9024a3ff9675453d069e075eceb12d9f8d7870e2374',
  topic1: '0x000000000000000000000000e37c75b2fcfff1d3ac963552a556e6b78b6d5137',
  topic2: '0x000000000000000000000000d53a1901004dae187fbc333c9925b40ba44495eb',
  topic3: '',
  data: '0x00000000000000000000000000000000000000000000000003eeaa698b48ec28000000000000000000000000000000000000000000ab24c7796fd2da3880000000000000000000000000000000000000000000000000019f12563854b6172d2e',
};
/** @von_hl, launched on the current, test-USDC pad 0x892b...8d76. */
const usdcLaunch = {
  block_time: '2026-10-01T00:00:00',
  block_number: 11097087,
  log_index: 2,
  tx_hash: '0xe840cc21a0372bb03b1907c6245e7e955856d8ff28fe16bc23ea561ace83aa49',
  address: '0x892b08a9b3987516a4ae5ab7d7e4d56642268d76',
  topic0: '0x096478a529366552bb1b4db7668203cf0d554c786f86c20059967309f535ab06',
  topic1: '0x0000000000000000000000003841e9a0ccb987b48d11c0175549cf49337cebaa',
  topic2: '0x000000000000000000000000f1aecc201d3eeb695c0f4409dbb5e01005e8e2ae',
  topic3: '0x00000000000000000000000000000000000000000000000000000000142f5f2f',
  data: '0x000000000000000000000000000000000000000000000000000000000000008000000000000000000000000000000000000000000000000000000000000000041ad3e08b2044997ec9b689f45ebebf740a78fc3b5dcd52d6db5903023e0a9631000000000000000000000000000000000000000000000000000000003b9aca000000000000000000000000000000000000000000000000000000000000000006766f6e5f686c0000000000000000000000000000000000000000000000000000',
};
/** The creator buy in the same tx. */
const usdcTrade = {
  block_time: '2026-10-01T00:00:00',
  block_number: 11097087,
  log_index: 5,
  tx_hash: '0xe840cc21a0372bb03b1907c6245e7e955856d8ff28fe16bc23ea561ace83aa49',
  address: '0x892b08a9b3987516a4ae5ab7d7e4d56642268d76',
  topic0: '0x2c76e7a47fd53e2854856ac3f0a5f3ee40d15cfaa82266357ea9779c486ab9c3',
  topic1: '0x0000000000000000000000003841e9a0ccb987b48d11c0175549cf49337cebaa',
  topic2: '0x000000000000000000000000f1aecc201d3eeb695c0f4409dbb5e01005e8e2ae',
  topic3: '',
  data: '0x000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000009713bf00000000000000000000000000000000000000000008b39d229f8b8cbc7e70d700000000000000000000000000000000000000000000000000000000000182c1000000000000000000000000000000000000000000000000000000003c31ddbf0000000000000000000000000000000000000000036edcf96b29647314818f29',
};

const HYPE_TOKEN = '0xe37c75b2fcfff1d3ac963552a556e6b78b6d5137';
const VON_HL = '0x3841e9a0ccb987b48d11c0175549cf49337cebaa';

describe('elysium launchpad decoders: Neuriio', () => {
  it('decodes a solo launch named after the X handle, with the pad quote', () => {
    const l = decodeLaunch(usdcLaunch);
    expect(l).toMatchObject({ token: VON_HL, launchpad: 'Neuriio', kind: 'curve', name: '@von_hl', symbol: 'VON_HL' });
    expect(l?.quote).toBe(NEURIIO_USDC);
    expect(l?.curve).toBeNull();
    expect(decodeLaunch(hypeLaunch)?.quote).toBe(NEURIIO_WHYPE);
  });

  it('keys a Neuriio market by its token, then by its pair', () => {
    expect(launchMarketKeys({ token: VON_HL, launchpad: 'Neuriio', curve: null, pool: null })).toEqual([VON_HL]);
    expect(launchMarketKeys({ token: VON_HL, launchpad: 'Neuriio', curve: null, pool: '0xpair' })).toEqual([VON_HL, '0xpair']);
  });

  it('decodes a test-USDC curve trade with a 6-decimal quote price', () => {
    const markets = new Map<string, LaunchMarket>([[VON_HL, { token: VON_HL, launchpad: 'Neuriio', quote: NEURIIO_USDC }]]);
    const t = decodeLaunchTrade(usdcTrade, markets);
    expect(t).toMatchObject({ token: VON_HL, venue: 'curve', is_buy: true, quote_amount: '9900991' });
    // About 1,010 virtual USDC against about 1.06B virtual tokens.
    expect(t!.price).toBeGreaterThan(9e-7);
    expect(t!.price).toBeLessThan(1e-6);
  });

  it('ignores a trade for an unknown token and a CorePad market', () => {
    expect(decodeLaunchTrade(usdcTrade, new Map())).toBeNull();
    const corepad = new Map<string, LaunchMarket>([[VON_HL, { token: VON_HL, launchpad: 'CorePad', quote: NEURIIO_USDC }]]);
    expect(decodeLaunchTrade(usdcTrade, corepad)).toBeNull();
  });

  it('decodes a HYPE curve trade and the graduation with its pair', () => {
    const markets = new Map<string, LaunchMarket>([[HYPE_TOKEN, { token: HYPE_TOKEN, launchpad: 'Neuriio', quote: NEURIIO_WHYPE }]]);
    const t = decodeLaunchTrade(hypeTrade, markets);
    expect(t).toMatchObject({ token: HYPE_TOKEN, venue: 'curve', is_buy: true });
    expect(t!.price).toBeGreaterThan(0);
    const g = decodeGraduation(hypeGraduated);
    expect(g).toEqual({
      curve: null,
      token: HYPE_TOKEN,
      pool: '0xd53a1901004dae187fbc333c9925b40ba44495eb',
      graduated_at: '2026-10-01T00:00:00.000Z',
    });
  });
});
