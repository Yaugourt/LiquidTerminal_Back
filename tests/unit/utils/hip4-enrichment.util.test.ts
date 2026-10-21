import {
  buildQuestionsWithOutcomes,
  enrichMarkets,
  enrichSettlements,
  type RawHip4Market,
  type RawHip4Question,
} from '../../../src/utils/hip4-enrichment.util';
import { indexOutcomeTemplates } from '../../../src/utils/hip4-market-names.util';
import { OUTCOME_TEMPLATES } from './hip4-templates.fixture';

const templates = indexOutcomeTemplates(OUTCOME_TEMPLATES);

/** A raw `/hip4/markets` row as HypeDexer sends it today (2026-09). */
function row(fields: Partial<RawHip4Market> & { outcome_id: number }): RawHip4Market {
  return {
    question_id: null,
    coin: `#${fields.outcome_id}`,
    class: '',
    underlying: '',
    name: '',
    description: '',
    side_specs: '[{"name":"Yes"},{"name":"No"}]',
    settled: 0,
    block_time: '2026-09-27T06:05:52.299000',
    ...fields,
  };
}

// Raw outcome 6024 on 2026-09-29, trimmed.
const hype6024 = row({
  outcome_id: 6024,
  name: 'Recurring',
  description: 'class:priceBinary|underlying:HYPE|expiry:20260928-0600|targetPrice:93.017|period:1d',
  class: 'priceBinary',
  underlying: 'HYPE',
  expiry: '20260928-0600',
  target_price: 93.017,
  period: '1d',
  settled: 1,
  block_time: '2026-09-28T06:00:12.035000',
  total_volume: 22068.45,
});

describe('enrichMarkets — settlement state', () => {
  it('reads the settled flag HypeDexer sends, with the settlement time in UTC', () => {
    const [m] = enrichMarkets([hype6024], [], []);
    expect(m.is_settled).toBe(true);
    expect(m.settled_at).toBe('2026-09-28T06:00:12.035000Z');
  });

  it('leaves an open market unsettled, without a settlement time', () => {
    const [m] = enrichMarkets([{ ...hype6024, settled: 0 }], [], []);
    expect(m.is_settled).toBe(false);
    expect(m.settled_at).toBeNull();
  });

  it('keeps one row per outcome when a filtered read repeats it', () => {
    const rows = enrichMarkets([hype6024, hype6024, hype6024], [], []);
    expect(rows).toHaveLength(1);
  });
});

describe('enrichMarkets — each row is its own market', () => {
  // Rows 1 and 12 from the oldest list: 12 is a named outcome of bucket question 1.
  const btc1 = row({
    outcome_id: 1,
    name: 'Recurring',
    description: 'class:priceBinary|underlying:BTC|expiry:20260504-0600|targetPrice:78213|period:1d',
    class: 'priceBinary',
    underlying: 'BTC',
    expiry: '20260504-0600',
    target_price: 78213,
    period: '1d',
  });
  const bucket12 = row({ outcome_id: 12, question_id: 1, name: 'Recurring Named Outcome', description: 'index:0', target_price: 0 });

  it('does not fill a row from outcome floor(id / 10)', () => {
    const byId = new Map(enrichMarkets([btc1, bucket12], [], []).map((m) => [m.outcome_id, m]));
    expect(byId.get(12)).toMatchObject({ class: null, underlying: null, expiry: null, period: null });
    expect(byId.get(12)?.display_name).not.toMatch(/BTC above/);
    expect(byId.get(1)?.display_name).toBe('BTC above 78,213 on May 4 at 6:00 AM UTC?');
  });

  it('does not read a side from the last digit of a raw outcome id', () => {
    const [m] = enrichMarkets([{ ...btc1, outcome_id: 20, coin: '#20' }], [], []);
    expect(m.side).toBeNull();
    expect(m.short_name).toBe('BTC');
  });
});

describe('enrichMarkets — names', () => {
  // Real rows (2026-09-29), trimmed.
  const hype6537 = row({
    outcome_id: 6537,
    name: 'template:binaryPrice',
    description: 'perp:HYPE|priceDescription:HYPE-USDC perp mark|seconds:60|threshold:86.859|time:20260928-2245',
    side_specs: '[{"name":"template:Yes"},{"name":"template:No"}]',
    target_price: 0,
  });
  const nationsLeague =
    'competition:UEFA Nations League|contestType:Match|participantA:Belgium|participantB:Turkiye|scheduledStart:20261002-1845|sport:Soccer|stage:League A, Matchday 3';
  const belgium6520 = row({
    outcome_id: 6520,
    question_id: 357,
    name: 'template:sportsContestParticipant2',
    description: 'participant:Belgium',
    target_price: 0,
    question_name: 'template:sportsContestResult',
    question_description: nationsLeague,
  });
  const draw6521 = { ...belgium6520, outcome_id: 6521, coin: '#6521', name: 'template:sportsContestDraw2', description: '' };
  const fallback6519 = { ...belgium6520, outcome_id: 6519, coin: '#6519', name: 'template fallback', description: 'other' };
  const eagles4667 = row({
    outcome_id: 4667,
    name: 'template:sportsContestWinner',
    description:
      'competition:NFL|contestType:game|participantA:Philadelphia Eagles|participantB:Chicago Bears|shortNameA:Eagles|shortNameB:Bears|sport:football|stage:Regular Season',
    side_specs: '[{"name":"template:{shortNameA}"},{"name":"template:{shortNameB}"}]',
  });

  it('titles a templated price market and gives it the fields of a priceBinary', () => {
    const [m] = enrichMarkets([hype6537], [], [], undefined, templates);
    expect(m).toMatchObject({
      display_name: 'HYPE above 86.859 at Sep 28, 10:45 PM UTC?',
      class: 'priceBinary',
      underlying: 'HYPE',
      target_price: 86.859,
      expiry: '20260928-2245',
      parsed_sides: [{ name: 'Yes' }, { name: 'No' }],
    });
    expect(m.question_description).toMatch(/^The market resolves to Yes if the HYPE price is above 86.859/);
  });

  it('still titles a templated price market when the registry is unavailable', () => {
    const [m] = enrichMarkets([hype6537], [], []);
    expect(m.display_name).toBe('HYPE above 86.859 on Sep 28 at 10:45 PM UTC?');
    expect(m.parsed_sides).toEqual([{ name: 'Yes' }, { name: 'No' }]);
  });

  it("names a question's outcomes after themselves and titles the question", () => {
    const rows = enrichMarkets([fallback6519, belgium6520, draw6521], [], [], undefined, templates);
    expect(rows.map((m) => m.display_name)).toEqual(['Other', 'Belgium', 'Draw']);
    expect(rows.every((m) => m.question_name === 'UEFA Nations League League A, Matchday 3: Belgium v Turkiye')).toBe(true);
    expect(rows[1].target_price).toBeNull();

    const [q] = buildQuestionsWithOutcomes(rows, []);
    expect(q.title).toBe('UEFA Nations League League A, Matchday 3: Belgium v Turkiye');
    expect(q.outcomes.map((o) => o.display_name)).toEqual(['Other', 'Belgium', 'Draw']);
  });

  it('names templated sides after the teams', () => {
    const [m] = enrichMarkets([eagles4667], [], [], undefined, templates);
    expect(m.parsed_sides).toEqual([{ name: 'Eagles' }, { name: 'Bears' }]);
    expect(m.display_name).toBe('NFL Regular Season: Philadelphia Eagles v Chicago Bears');
  });

  it('names legacy question outcomes after themselves, not after the question', () => {
    const q32: RawHip4Question = {
      question_id: 32,
      name: '2026 World Cup Champion',
      description: 'Each associated outcome…',
      fallback_outcome: 170,
      named_outcomes: [171, 172],
      settled_named_outcomes: [],
    };
    const rows = enrichMarkets(
      [
        row({ outcome_id: 170, question_id: 32, name: 'Fallback' }),
        row({ outcome_id: 171, question_id: 32, name: 'Algeria' }),
        row({ outcome_id: 172, question_id: 32, name: 'Argentina' }),
      ],
      [],
      [q32]
    );
    expect(rows.map((m) => m.display_name)).toEqual(['Fallback', 'Algeria', 'Argentina']);
    expect(buildQuestionsWithOutcomes(rows, [q32])[0].title).toBe('2026 World Cup Champion');
  });

  it('names the ranges of a recurring price-bucket question', () => {
    const q1: RawHip4Question = {
      question_id: 1,
      name: 'Recurring',
      description: 'class:priceBucket|underlying:BTC|expiry:20260509-0600|priceThresholds:77991,81174|period:1d',
      fallback_outcome: 11,
      named_outcomes: [12, 13, 14],
      settled_named_outcomes: [],
    };
    const rows = enrichMarkets(
      [
        row({ outcome_id: 11, question_id: 1, name: 'Recurring Fallback', description: 'other' }),
        row({ outcome_id: 12, question_id: 1, name: 'Recurring Named Outcome', description: 'index:0' }),
        row({ outcome_id: 13, question_id: 1, name: 'Recurring Named Outcome', description: 'index:1' }),
        row({ outcome_id: 14, question_id: 1, name: 'Recurring Named Outcome', description: 'index:2' }),
      ],
      [],
      [q1]
    );
    expect(rows.map((m) => m.display_name)).toEqual(['Recurring Fallback', 'BTC < 77,991', 'BTC 77,991–81,174', 'BTC ≥ 81,174']);
    expect(rows[1]).toMatchObject({ class: 'priceBucket', underlying: 'BTC', expiry: '20260509-0600', target_price: null });
    expect(buildQuestionsWithOutcomes(rows, [q1])[0].title).toBe('BTC price at May 9, 6:00 AM UTC');
  });
});

describe('buildQuestionsWithOutcomes — markets with no question', () => {
  // Rows from the oldest list (2026-10-21), trimmed: 110 and 111 are two
  // unrelated markets, 141 and 170 two games of the same series.
  const ucl110 = row({
    outcome_id: 110,
    name: 'Champions League Winner',
    side_specs: '[{"name":"PSG"},{"name":"Arsenal"}]',
    total_volume: 1868551,
  });
  const btc111 = row({
    outcome_id: 111,
    name: 'Recurring',
    description: 'class:priceBinary|underlying:BTC|expiry:20260528-0600|targetPrice:75668|period:1d',
    class: 'priceBinary',
    underlying: 'BTC',
    expiry: '20260528-0600',
    target_price: 75668,
    period: '1d',
    total_volume: 1512465,
  });
  const nbaSides = '[{"name":"San Antonio"},{"name":"New York"}]';
  const game141 = row({ outcome_id: 141, name: 'NBA Finals Game 2', side_specs: nbaSides, total_volume: 380715 });
  const game170 = row({ outcome_id: 170, name: 'NBA Finals Game 3', side_specs: nbaSides, total_volume: 745517 });

  const questionsOf = (rows: RawHip4Market[], mids?: Map<string, number>) =>
    buildQuestionsWithOutcomes(enrichMarkets(rows, [], []), [], mids);

  it('never pairs raw outcomes 10N and 10N + 1 as the Yes and No of one market', () => {
    const qs = questionsOf([ucl110, btc111]);
    expect(qs).toHaveLength(2);
    const ucl = qs.find((q) => q.singleton_outcome_id === 110);
    const btc = qs.find((q) => q.singleton_outcome_id === 111);
    expect(ucl).toMatchObject({ title: 'Champions League Winner', total_volume: 1868551 });
    expect(ucl?.outcomes.map((o) => [o.display_name, o.coin])).toEqual([
      ['PSG', '#1100'],
      ['Arsenal', '#1101'],
    ]);
    expect(btc).toMatchObject({
      title: 'BTC above 75,668 on May 28 at 6:00 AM UTC?',
      class: 'priceBinary',
      total_volume: 1512465,
    });
    expect(btc?.outcomes.map((o) => [o.display_name, o.coin])).toEqual([
      ['Yes', '#1110'],
      ['No', '#1111'],
    ]);
  });

  it('gives a lone market both of its sides, each on its own coin', () => {
    for (const m of [game141, game170]) {
      const [q] = questionsOf([m]);
      expect(q.outcome_count).toBe(2);
      expect(q.outcomes.map((o) => o.display_name)).toEqual(['San Antonio', 'New York']);
      expect(q.outcomes.map((o) => o.coin)).toEqual([`#${m.outcome_id * 10}`, `#${m.outcome_id * 10 + 1}`]);
      expect(q.outcomes.every((o) => o.outcome_id === m.outcome_id)).toBe(true);
    }
  });

  it("prices each side from its own coin, not from the row's #N label", () => {
    // #141 is outcome 14's No coin: another market.
    const mids = new Map([
      ['#141', 0.99],
      ['#1410', 0.25],
      ['#1411', 0.75],
    ]);
    const [q] = questionsOf([game141], mids);
    expect(q.outcomes.map((o) => o.mid_price)).toEqual([0.25, 0.75]);
  });

  it('keeps the market volume on the question, not repeated on each side', () => {
    const [q] = questionsOf([game141]);
    expect(q.total_volume).toBe(380715);
    expect(q.outcomes.map((o) => o.total_volume)).toEqual([null, null]);
  });

  it('falls back to Yes and No sides when a market lists none', () => {
    const [q] = questionsOf([row({ outcome_id: 142, name: '2026 NBA Finals champion', side_specs: null })]);
    expect(q.title).toBe('2026 NBA Finals champion');
    expect(q.outcomes.map((o) => [o.display_name, o.coin])).toEqual([
      ['Yes', '#1420'],
      ['No', '#1421'],
    ]);
  });

  it('settles both sides with the market', () => {
    const [q] = questionsOf([{ ...btc111, settled: 1, block_time: '2026-05-28T06:00:10' }]);
    expect(q).toMatchObject({ status: 'settled', resolved_at: '2026-05-28T06:00:10Z' });
    expect(q.outcomes.every((o) => o.is_settled && o.settled_at === '2026-05-28T06:00:10Z')).toBe(true);
  });

  it("leaves a grouped question's outcomes on their Yes coin (no coin field)", () => {
    const q1: RawHip4Question = {
      question_id: 1,
      name: 'Recurring',
      description: 'class:priceBucket|underlying:BTC|expiry:20260509-0600|priceThresholds:77991,81174|period:1d',
      fallback_outcome: 11,
      named_outcomes: [12, 13],
      settled_named_outcomes: [],
    };
    const rows = enrichMarkets(
      [
        row({ outcome_id: 12, question_id: 1, name: 'Recurring Named Outcome', description: 'index:0' }),
        row({ outcome_id: 13, question_id: 1, name: 'Recurring Named Outcome', description: 'index:1' }),
      ],
      [],
      [q1]
    );
    const [q] = buildQuestionsWithOutcomes(rows, [q1], new Map([['#120', 0.4]]));
    expect(q.outcomes.map((o) => o.outcome_id)).toEqual([12, 13]);
    expect(q.outcomes.every((o) => o.coin === undefined)).toBe(true);
  });
});

describe('enrichSettlements — names', () => {
  it('names a settlement after its market, rendered from the template', () => {
    const market = row({
      outcome_id: 6537,
      name: 'template:binaryPrice',
      description: 'perp:HYPE|priceDescription:HYPE-USDC perp mark|seconds:60|threshold:86.859|time:20260928-2245',
      side_specs: '[{"name":"template:Yes"},{"name":"template:No"}]',
      settled: 1,
    });
    const enriched = enrichMarkets([market], [], [], undefined, templates);
    const [s] = enrichSettlements([{ outcome_id: 6537, settle_fraction: 1, block_time: '2026-09-28T22:45:10' }], enriched, []);
    expect(s).toMatchObject({ question_name: 'HYPE above 86.859 at Sep 28, 10:45 PM UTC?', winner_name: 'Yes', coin: '#6537' });
  });

  it('never shows a raw template or placeholder as the question name', () => {
    const enriched = enrichMarkets(
      [row({ outcome_id: 6520, question_id: 357, name: 'template:sportsContestParticipant2', description: 'participant:Belgium', question_name: 'template:sportsContestResult', question_description: '' })],
      [],
      [{ question_id: 357, name: 'template:sportsContestResult', description: '', fallback_outcome: 6519, named_outcomes: [6520], settled_named_outcomes: [] }],
      undefined,
      templates
    );
    const [s] = enrichSettlements([{ outcome_id: 6520, settle_fraction: 1, block_time: '2026-10-02T21:00:00' }], enriched, []);
    // The question's keywords are missing here: fall back to the outcome's own name.
    expect(s.question_name).toBe('Belgium');
  });
});

describe('enrichSettlements — times', () => {
  it('sends the settlement time as UTC', () => {
    const [s] = enrichSettlements(
      [{ outcome_id: 6024, settle_fraction: 0, details: 'price:89.0163', block_time: '2026-09-28T06:00:14.527538' }],
      [],
      []
    );
    expect(s.settled_at).toBe('2026-09-28T06:00:14.527538Z');
    expect(s.settled_px).toBe(89.0163);
    expect(s.winner_side).toBe(1);
  });
});
