/**
 * The NFT card SVG comes from a third party and is shown on the mint page:
 * only a plain drawing with one name text element gets through.
 */
jest.mock('../../../src/core/redis.service', () => ({ redisService: {} }));
jest.mock('../../../src/utils/logDeduplicator', () => ({
  logDeduplicator: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { isSafeCardSvg, stripCardScripts } from '../../../src/clients/hlnames/hlnames.client';

const CARD =
  '<?xml version="1.0"?><svg viewBox="0 0 530 530" xmlns="http://www.w3.org/2000/svg"><defs><clipPath id="clip"><rect width="530" height="530"/></clipPath></defs>' +
  '<g clip-path="url(#clip)"><rect width="530" height="530" fill="#000"/></g>' +
  '<text id="dt" x="50%" y="480" fill="white" text-anchor="middle" font-size="27px">liquidterminal.hl</text></svg>';

describe('isSafeCardSvg', () => {
  it('accepts a plain card with one name text', () => {
    expect(isSafeCardSvg(CARD)).toBe(true);
  });

  it('accepts their card once its sizing script is stripped', () => {
    const withScript = CARD.replace('</svg>', '<script><![CDATA[function adjustTextSize(){}adjustTextSize();]]></script></svg>');
    expect(isSafeCardSvg(withScript)).toBe(false);
    expect(isSafeCardSvg(stripCardScripts(withScript))).toBe(true);
  });

  it.each([
    ['a script', CARD.replace('<defs>', '<script>alert(1)</script><defs>')],
    ['an event handler', CARD.replace('<rect width', '<rect onload="alert(1)" width')],
    ['a foreignObject', CARD.replace('<defs>', '<foreignObject><div/></foreignObject><defs>')],
    ['an external href', CARD.replace('<defs>', '<image href="https://evil.example/x.png"/><defs>')],
    ['an external xlink:href', CARD.replace('<defs>', '<use xlink:href="https://evil.example/s.svg#a"/><defs>')],
    ['a javascript: url', CARD.replace('url(#clip)', 'javascript:alert(1)')],
    ['no name text', CARD.replace('id="dt"', 'id="other"')],
    ['two name texts', CARD.replace('</svg>', '<text id="dt">x</text></svg>')],
  ])('refuses %s', (_why, svg) => {
    expect(isSafeCardSvg(svg)).toBe(false);
  });
});
