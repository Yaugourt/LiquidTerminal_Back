import fs from 'fs';
import path from 'path';
import {
  canonicalTwitter,
  liveTicker,
  mergeSources,
  parseDataJson,
  parseDetailPage,
  parseListingPage,
  routeLinks,
} from '../../../src/services/project/hypurr-sync/hypurr.scraper';
import {
  domainKey,
  mapCategories,
  matchProjects,
  normalizeName,
  truncateDesc,
  twitterHandle,
} from '../../../src/services/project/hypurr-sync/hypurr.matcher';
import { HypurrProject, LtProject } from '../../../src/services/project/hypurr-sync/hypurr-sync.types';

// Fixtures are trimmed copies of the live hypurr.co pages and data.json (fetched 2026-11-01).
const FIXTURES = path.join(__dirname, '../../fixtures/hypurr');
const read = (f: string): string => fs.readFileSync(path.join(FIXTURES, f), 'utf-8');

describe('hypurr scraper', () => {
  it('parses listing cards and the next page link', () => {
    const page = parseListingPage(read('listing-page1.html'));
    expect(page.nextPageQuery).toBe('?3502a91f_page=2');
    expect(page.cards.map((c) => c.slug)).toEqual(['0xarchive', '21shares', 'across-protocol']);
    expect(page.cards[0]).toEqual({
      slug: '0xarchive',
      name: '0xArchive',
      logo: 'https://cdn.prod.website-files.com/670fbe4b9207c73d64718812/69b64c1308953b0691eec92d_ZPc8s62H_400x400.png',
      twitter: 'https://x.com/0xArchiveIO',
      categories: ['Infrastructure'],
      description: expect.stringContaining('perpetuals historical data'),
    });
  });

  it('stops on the last page', () => {
    const page = parseListingPage(read('listing-page-last.html'));
    expect(page.nextPageQuery).toBeNull();
    expect(page.cards.map((c) => c.slug)).toEqual(['stable-jack', 'staking-rewards']);
    expect(page.cards[0].categories).toEqual(['Builder Codes', 'AI']);
  });

  it('parses data.json records and ignores junk', () => {
    const recs = parseDataJson(JSON.parse(read('data.json')));
    expect(recs).toHaveLength(5);
    expect(recs.find((r) => r.slug === 'across-protocol')).toMatchObject({ site: 'https://across.to/', token: 'Yes', ticker: 'ACX' });
    expect(recs.find((r) => r.slug === '21shares')?.tg).toBeNull();
    expect(parseDataJson({ nope: 1 })).toEqual([]);
    expect(parseDataJson({ projects: [null, { name: 'no slug' }] })).toEqual([]);
  });

  it('parses the project page link buttons', () => {
    expect(parseDetailPage(read('detail-0xarchive.html'))).toEqual({
      website: 'https://www.0xarchive.io/',
      twitter: 'https://x.com/0xArchiveIO',
      telegram: 'https://t.me/archivedotio',
    });
  });

  it('merges listing + data.json by slug, ticker only when the token is live', () => {
    const cards = [...parseListingPage(read('listing-page1.html')).cards, ...parseListingPage(read('listing-page-last.html')).cards];
    const merged = mergeSources(cards, parseDataJson(JSON.parse(read('data.json'))));
    expect(merged).toHaveLength(5);
    const across = merged.find((p) => p.slug === 'across-protocol') as HypurrProject;
    expect(across).toMatchObject({ website: 'https://across.to/', twitter: 'https://x.com/AcrossProtocol', ticker: 'ACX', telegram: null });
    const archive = merged.find((p) => p.slug === '0xarchive') as HypurrProject;
    expect(archive).toMatchObject({ ticker: null, telegram: 'https://t.me/archivedotio', sourceUrl: 'https://www.hypurr.co/ecosystem-projects/0xarchive' });
  });

  it('uses detail pages for slugs missing from data.json, and data.json alone without a listing', () => {
    const cards = parseListingPage(read('listing-page1.html')).cards;
    const details = new Map([['0xarchive', parseDetailPage(read('detail-0xarchive.html'))]]);
    const merged = mergeSources(cards, [], details);
    expect(merged[0]).toMatchObject({ website: 'https://www.0xarchive.io/', telegram: 'https://t.me/archivedotio' });
    expect(merged[1].website).toBeNull();

    const fromJson = mergeSources([], parseDataJson(JSON.parse(read('data.json'))));
    expect(fromJson).toHaveLength(5);
    expect(fromJson.every((p) => p.logo === null)).toBe(true);
  });

  it('routes mislabelled links to the right column', () => {
    expect(routeLinks(['https://x.com/Foo', 'https://discord.gg/abc', 'https://t.me/foo'])).toEqual({
      website: null,
      twitter: 'https://x.com/Foo',
      telegram: 'https://t.me/foo',
      discord: 'https://discord.gg/abc',
    });
    expect(canonicalTwitter('https://x.com/cabaldotmarket?s=21')).toBe('https://x.com/cabaldotmarket');
    expect(canonicalTwitter('https://t.me/chip1cr')).toBeNull();
  });
});

describe('hypurr matcher', () => {
  const h = (over: Partial<HypurrProject>): HypurrProject => ({
    slug: 's', name: 'N', website: null, twitter: null, telegram: null, discord: null, logo: null,
    categories: [], description: null, ticker: null, sourceUrl: 'https://www.hypurr.co/ecosystem-projects/s', ...over,
  });
  const lt = (over: Partial<LtProject>): LtProject => ({
    id: 1, title: 'N', desc: 'A real description', logo: 'https://r2/x.png', token: null, twitter: null,
    telegram: null, discord: null, website: null, categories: [], ...over,
  });

  it('normalizes keys', () => {
    expect(normalizeName('Café Protocol!')).toBe('cafeprotocol');
    expect(twitterHandle('https://x.com/Foo_Bar/')).toBe('foo_bar');
    expect(twitterHandle('https://x.com/i/communities/1')).toBeNull();
    expect(domainKey('https://app.foo.xyz/trade')).toBe('foo.xyz');
    expect(domainKey('https://linktr.ee/foo')).toBeNull();
    expect(domainKey('https://foo.vercel.app')).toBe('foo.vercel.app');
    expect(truncateDesc('word '.repeat(80)).length).toBeLessThanOrEqual(255);
  });

  it('maps Hypurr tags to LT categories with aliases', () => {
    expect(mapCategories(['Defi / Yields', 'Data Analytics', 'Institutions'], ['DEFI', 'Data analytics'])).toEqual([
      { name: 'DEFI', exists: true },
      { name: 'Data analytics', exists: true },
      { name: 'Institutions', exists: false },
    ]);
  });

  it('matches by twitter, website, then name, and reports missing / LT-only', () => {
    const hypurr = [
      h({ slug: 'a', name: 'Alpha', twitter: 'https://x.com/alpha' }),
      h({ slug: 'b', name: 'Beta Finance', website: 'https://beta.fi' }),
      h({ slug: 'c', name: 'Gamma Labs' }),
      h({ slug: 'd', name: 'Delta', website: 'https://delta.xyz' }),
    ];
    const ltProjects = [
      lt({ id: 1, title: 'ALPHA app', twitter: 'https://twitter.com/Alpha' }),
      lt({ id: 2, title: 'Beta', website: 'https://www.beta.fi/' }),
      lt({ id: 3, title: 'Gamma' }),
      lt({ id: 4, title: 'Omega' }),
    ];
    const diff = matchProjects(hypurr, ltProjects, []);
    expect(diff.matched.map((m) => [m.hypurr.slug, m.lt.id, m.reason])).toEqual([
      ['a', 1, 'twitter'],
      ['b', 2, 'website'],
      ['c', 3, 'loose-name'],
    ]);
    expect(diff.missing.map((m) => m.slug)).toEqual(['d']);
    expect(diff.ltOnly.map((p) => p.id)).toEqual([4]);
  });

  it('skips a key shared by several LT projects', () => {
    const diff = matchProjects(
      [h({ slug: 'x', name: 'Xeno', twitter: 'https://x.com/xeno' })],
      [lt({ id: 1, title: 'Xeno One', twitter: 'https://x.com/xeno' }), lt({ id: 2, title: 'Xeno Two', twitter: 'https://x.com/xeno' })],
      []
    );
    expect(diff.matched).toHaveLength(0);
    expect(diff.ambiguous).toEqual([{ key: 'twitter:xeno', ltTitles: ['Xeno One', 'Xeno Two'] }]);
  });

  it('marks only empty LT fields as fillable', () => {
    const diff = matchProjects(
      [
        h({
          slug: 'a', name: 'Alpha', twitter: 'https://x.com/alpha', website: 'https://alpha.io', telegram: 'https://t.me/alpha',
          ticker: 'ALP', description: 'Hypurr bio', categories: ['Defi / Yields'], logo: 'https://cdn/x.png',
        }),
      ],
      [lt({ id: 1, title: 'Alpha', twitter: 'https://x.com/alpha', website: 'https://other.io', desc: 'Alpha' })],
      ['DEFI']
    );
    const byField = Object.fromEntries(diff.matched[0].diffs.map((d) => [d.field, d.fillable]));
    expect(byField).toEqual({ website: false, telegram: true, description: true, token: true, categories: true });
  });
});

describe('hypurr ticker', () => {
  const rec = (token: string, ticker: string) => ({ slug: 's', name: 'n', site: null, x: null, tg: null, token, ticker, tags: [], bio: null });
  it('keeps live tickers only and drops placeholders', () => {
    expect(liveTicker(rec('Yes', 'ACX'))).toBe('ACX');
    expect(liveTicker(rec('Yes', '$HFUN'))).toBe('HFUN');
    expect(liveTicker(rec('Yes', 'PEAR (Not on HL, ERC-20)'))).toBe('PEAR');
    expect(liveTicker(rec('Yes', 'NFT'))).toBeNull();
    expect(liveTicker(rec('Not yet', 'ABC'))).toBeNull();
  });
});
