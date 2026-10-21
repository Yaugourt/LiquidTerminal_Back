/**
 * Pure helpers that turn raw HypeDexer HIP-4 payloads into shapes consumable by
 * the frontend without additional client-side cross-referencing.
 *
 * No I/O, no caching — just shape transformations.
 */

import {
  EMPTY_TEMPLATE_INDEX,
  isPlaceholderName,
  isTemplateFallbackName,
  priceBucketExpiry,
  priceBucketOutcomeName,
  priceBucketQuestionTitle,
  priceBucketUnderlying,
  renderSideName,
  renderTemplateRules,
  renderTemplateTitle,
  templateIdOf,
  templatePriceFields,
  type Hip4TemplateIndex,
} from './hip4-market-names.util';

export interface RawHip4Market {
  outcome_id: number;
  question_id: number | null;
  coin: string | null;
  class: string | null;
  underlying: string | null;
  name: string | null;
  side?: number | null;
  side_name?: string | null;
  side_specs?: string | null;
  mid_price?: number | null;
  volume_24h?: number | null;
  total_volume?: number | null;
  total_trades?: number | null;
  total_fills?: number | null;
  open_interest?: number | null;
  unique_users?: number | null;
  is_settled?: boolean | null;
  settled_at?: string | null;
  /** What HypeDexer sends today instead of `is_settled` (0 / 1). */
  settled?: number | boolean | null;
  /** Last on-chain update of the row: the settlement time once settled. */
  block_time?: string | null;
  expiry?: string | null;
  period?: string | null;
  target_price?: number | null;
  description?: string | null;
  /** The row's question, inlined by HypeDexer ("" when standalone). */
  question_name?: string | null;
  question_description?: string | null;
}

export interface RawHip4Question {
  question_id: number;
  name: string | null;
  description: string | null;
  fallback_outcome: number | null;
  named_outcomes: number[] | null;
  settled_named_outcomes: number[] | null;
  updated_at?: string | null;
}

export interface RawHip4OutcomeToken {
  outcome_id: number;
  coin: string | null;
  spot_index?: number | null;
  spot_name?: string | null;
  deployer_fee_share?: number | null;
  sz_decimals?: number | null;
  wei_decimals?: number | null;
  updated_at?: string | null;
}

export interface RawHip4Settlement {
  outcome_id: number;
  // mainnet fields
  block_time?: string | null;
  settle_fraction?: number | null;
  details?: string | null;       // "price:78212.4"
  block_height?: number | null;
  nonce?: number | null;
  broadcaster?: string | null;
  // legacy/optional fields
  coin?: string | null;
  settled_px?: number | null;
  settled_at?: string | null;
  winner_side?: number | null;
  tx_hash?: string | null;
}

export interface ParsedSide {
  name: string;
}

export interface Hip4MarketEnriched {
  outcome_id: number;
  question_id: number | null;
  coin: string | null;
  class: string | null;
  class_normalized: string;
  underlying: string | null;
  name: string | null;
  side: number | null;
  side_name: string | null;
  parsed_sides: ParsedSide[] | null;
  token_name: string | null;
  question_name: string | null;
  question_description: string | null;
  display_name: string;
  short_name: string;
  mid_price: number | null;
  volume_24h: number | null;
  total_volume: number | null;
  total_trades: number | null;
  open_interest: number | null;
  is_settled: boolean;
  settled_at: string | null;
  expiry: string | null;
  period: string | null;
  target_price: number | null;
}

export interface Hip4QuestionOutcome {
  outcome_id: number;
  side_name: string | null;
  display_name: string;
  mid_price: number | null;
  volume_24h: number | null;
  total_volume: number | null;
  open_interest: number | null;
  is_settled: boolean;
  settled_at: string | null;
  /**
   * The side's traded coin, `#(10N + side)`, on the two outcomes of a
   * standalone market: both carry its raw outcome id N, the coin tells them
   * apart. Absent on a grouped question's outcomes (each trades on its Yes
   * coin, `#(10 × outcome_id)`).
   */
  coin?: string;
}

export interface Hip4QuestionWithOutcomes {
  question_id: number | null;
  title: string | null;
  description: string | null;
  class: string | null;
  underlying: string | null;
  outcome_count: number;
  total_volume: number;
  created_at: string | null;
  resolved_at: string | null;
  status: 'live' | 'settled';
  singleton_outcome_id: number | null;
  expiry: string | null;
  period: string | null;
  target_price: number | null;
  outcomes: Hip4QuestionOutcome[];
}

export interface Hip4SettlementEnriched {
  outcome_id: number;
  coin: string | null;
  settled_px: number | null;   // underlying asset price at settlement (e.g. 78212.4 for BTC)
  settle_fraction: number | null; // YES fraction at settlement (0.0 = NO won, 1.0 = YES won)
  settled_at: string;
  winner_side: number | null;
  tx_hash: string | null;
  winner_name: string | null;
  question_name: string | null;
}

const MONTHS_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

function formatPriceBinaryTitle(underlying: string, targetPrice: number, expiry: string | null | undefined): string {
  const priceStr = targetPrice >= 1000
    ? targetPrice.toLocaleString('en-US', { maximumFractionDigits: 0 })
    : String(targetPrice);
  if (expiry) {
    const m = expiry.match(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})$/);
    if (m) {
      const month = MONTHS_SHORT[parseInt(m[2]) - 1];
      const day = parseInt(m[3]);
      const hh = parseInt(m[4]);
      const mm = m[5];
      const ampm = hh < 12 ? 'AM' : 'PM';
      const h12 = hh === 0 ? 12 : hh > 12 ? hh - 12 : hh;
      const time = mm === '00' ? `${h12}:00 ${ampm}` : `${h12}:${mm} ${ampm}`;
      return `${underlying} above ${priceStr} on ${month} ${day} at ${time} UTC?`;
    }
  }
  return `${underlying} above ${priceStr}?`;
}

/** Parse the stringified JSON in raw market `side_specs` into a typed list of sides. */
export function parseSideSpecs(raw: string | null | undefined): ParsedSide[] | null {
  if (!raw || typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed === '[]') return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (!Array.isArray(parsed)) return null;
    const sides: ParsedSide[] = [];
    for (const entry of parsed) {
      if (entry && typeof entry === 'object' && typeof (entry as { name?: unknown }).name === 'string') {
        sides.push({ name: (entry as { name: string }).name });
      }
    }
    return sides.length ? sides : null;
  } catch {
    return null;
  }
}

/** Normalize the raw `class` field: empty/null becomes `custom`. */
export function normalizeClass(raw: string | null | undefined): string {
  const c = (raw ?? '').trim();
  return c ? c : 'custom';
}

/**
 * Pick the best user-facing name from all available sources, in priority order:
 * 1. Title rendered from the market's template → "HYPE above 90.416 at Sep 28, 12:00 PM UTC?", "Belgium"
 * 2. priceBinary fields → human-readable "BTC above 78,213 on May 3 at 6:00 AM UTC?"
 *    (tokenName is intentionally skipped — spot_name = "USDC" is the quote token, not the market)
 * 3. Price range of a price-bucket outcome → "BTC 77,991–81,174"
 * 4. Named side from parsed side_specs at the market's side index (multi-outcome custom markets)
 * 5. The market's own name when it is one (a question's outcomes: "Algeria", "Draw", "Fallback")
 * 6. Question name (outcomes named after a deployer placeholder)
 * 7. Outcome token spot_name (HIP-4 token registry, for non-priceBinary only)
 * 8. Market.name (HypeDexer's own label), unless "Recurring" or a template reference
 * 9. Market.coin as last-resort identifier (e.g. "#50790")
 */
export function deriveDisplayName(params: {
  parsedSides: ParsedSide[] | null;
  side: number | null;
  questionName: string | null;
  tokenName: string | null;
  marketName: string | null;
  coin: string | null;
  cls?: string | null;
  underlying?: string | null;
  targetPrice?: number | null;
  expiry?: string | null;
  templateTitle?: string | null;
  bucketName?: string | null;
}): string {
  const { parsedSides, side, questionName, tokenName, marketName, coin, cls, underlying, targetPrice, expiry } = params;

  if (params.templateTitle) return params.templateTitle;
  if (cls === 'priceBinary' && underlying && targetPrice != null) {
    return formatPriceBinaryTitle(underlying, targetPrice, expiry);
  }
  if (params.bucketName) return params.bucketName;
  if (parsedSides && side != null && parsedSides[side]?.name) {
    return parsedSides[side].name;
  }
  if (marketName && !isPlaceholderName(marketName, coin)) return marketName.trim();
  if (questionName && questionName.trim()) return questionName;
  if (tokenName && tokenName.trim()) return tokenName;
  if (
    marketName && marketName.trim() && marketName.trim() !== 'Recurring' &&
    !templateIdOf(marketName) && !isTemplateFallbackName(marketName)
  ) {
    return marketName;
  }
  return coin ?? '';
}

/**
 * A question's title: rendered from its template, a price-bucket title, or
 * its own name. Null for a template that cannot be rendered.
 */
function questionTitle(
  name: string | null | undefined,
  description: string | null | undefined,
  templates: Hip4TemplateIndex
): string | null {
  const rendered = renderTemplateTitle(name, description, templates) ?? priceBucketQuestionTitle(description);
  if (rendered) return rendered;
  const n = (name ?? '').trim();
  if (!n || templateIdOf(n) || isTemplateFallbackName(n)) return null;
  return n;
}

/** Side names with templates rendered (`template:{shortNameA}` → "Eagles"). */
function renderSides(sides: ParsedSide[] | null, description: string | null | undefined): ParsedSide[] | null {
  if (!sides) return null;
  return sides.map((s, i) => ({ name: renderSideName(s.name, description) ?? `Side ${i + 1}` }));
}

function indexOutcomeTokens(tokens: RawHip4OutcomeToken[]): Map<number, RawHip4OutcomeToken> {
  const map = new Map<number, RawHip4OutcomeToken>();
  for (const t of tokens) {
    if (typeof t.outcome_id === 'number') map.set(t.outcome_id, t);
  }
  return map;
}

function indexQuestions(questions: RawHip4Question[]): Map<number, RawHip4Question> {
  const map = new Map<number, RawHip4Question>();
  for (const q of questions) {
    if (typeof q.question_id === 'number') map.set(q.question_id, q);
  }
  return map;
}

/**
 * HypeDexer sends UTC times without a zone designator, which `new Date()`
 * reads as local time.
 */
function asUtcIso(time: string | null | undefined): string | null {
  if (!time) return null;
  return /(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(time) ? time : `${time}Z`;
}

/**
 * One row per outcome: filtered reads (`?outcome_id=`, `?question_id=`) can
 * return the same market row several times.
 */
function uniqueByOutcomeId(markets: RawHip4Market[]): RawHip4Market[] {
  const seen = new Set<number>();
  return markets.filter((m) => {
    if (seen.has(m.outcome_id)) return false;
    seen.add(m.outcome_id);
    return true;
  });
}

/**
 * Left-join markets with outcome_tokens + questions and derive display fields.
 * `templates` (Hyperliquid's registry) titles the markets deployed from a
 * template; without it they fall back to their structured fields or coin.
 */
export function enrichMarkets(
  rawMarkets: RawHip4Market[],
  outcomeTokens: RawHip4OutcomeToken[],
  questions: RawHip4Question[],
  midPrices?: Map<string, number>,
  templates: Hip4TemplateIndex = EMPTY_TEMPLATE_INDEX
): Hip4MarketEnriched[] {
  const markets = uniqueByOutcomeId(rawMarkets);
  const tokenIdx = indexOutcomeTokens(outcomeTokens);
  const questionIdx = indexQuestions(questions);

  return markets.map((m) => {
    const parsedSides = renderSides(parseSideSpecs(m.side_specs), m.description);
    const token = tokenIdx.get(m.outcome_id);
    const question = m.question_id != null ? questionIdx.get(m.question_id) : undefined;
    const tokenName = token?.spot_name && token.spot_name.trim() ? token.spot_name : null;
    // HypeDexer inlines the question on each of its rows: questions outside
    // the metadata list still get a title.
    const rawQuestionName = question?.name || m.question_name || null;
    const rawQuestionDescription = question?.description || m.question_description || null;
    const questionName = m.question_id != null
      ? questionTitle(rawQuestionName, rawQuestionDescription, templates)
      : null;
    const questionRules = m.question_id != null
      ? renderTemplateRules(rawQuestionName, rawQuestionDescription, templates) ?? rawQuestionDescription
      : renderTemplateRules(m.name, m.description, templates);

    // Every row is its own market. Rows 10–99 are not side coins of rows 0–9:
    // filling their empty fields from outcome floor(id / 10) titled a bucket
    // question's outcomes "BTC above 0 on May 4". Price templates and bucket
    // questions state the same fields in their descriptions.
    const priceFields = templatePriceFields(m.name, m.description);
    const bucketUnderlying = m.question_id != null ? priceBucketUnderlying(rawQuestionDescription) : null;
    const effectiveClass = m.class?.trim() ? m.class : priceFields?.cls ?? (bucketUnderlying ? 'priceBucket' : null);
    const effectiveUnderlying = m.underlying?.trim() ? m.underlying : priceFields?.underlying ?? bucketUnderlying;
    // Non-price rows come with a 0 strike.
    const effectiveTargetPrice = priceFields ? priceFields.targetPrice : m.target_price || null;
    const effectiveExpiry = m.expiry?.trim()
      ? m.expiry
      : priceFields?.expiry ?? (bucketUnderlying ? priceBucketExpiry(rawQuestionDescription) : null);
    const effectivePeriod = m.period?.trim() ? m.period : null;

    // Inject live mid price from HL allMids if available.
    const liveMidPrice = m.coin ? (midPrices?.get(m.coin) ?? null) : null;

    const displayName = deriveDisplayName({
      parsedSides,
      side: m.side ?? null,
      questionName,
      tokenName,
      marketName: m.name,
      coin: m.coin,
      cls: effectiveClass,
      underlying: effectiveUnderlying,
      targetPrice: effectiveTargetPrice,
      expiry: effectiveExpiry,
      templateTitle: renderTemplateTitle(m.name, m.description, templates),
      bucketName: bucketUnderlying ? priceBucketOutcomeName(rawQuestionDescription, m.description) : null,
    });

    const totalTrades = m.total_trades ?? m.total_fills ?? null;
    const settled = Boolean(m.is_settled ?? m.settled);

    // A row's id is a raw outcome id, not `10 * outcome + side`: only a row
    // that states its side is one side of a market.
    const side = m.side ?? null;
    const shortName = effectiveUnderlying && side != null && side <= 1
      ? `${effectiveUnderlying} ${side === 0 ? 'YES' : 'NO'}`
      : (effectiveUnderlying ?? (isPlaceholderName(m.name, m.coin) ? displayName : m.name) ?? m.coin ?? '');

    return {
      outcome_id: m.outcome_id,
      question_id: m.question_id ?? null,
      coin: m.coin ?? null,
      class: effectiveClass,
      class_normalized: normalizeClass(effectiveClass),
      underlying: effectiveUnderlying,
      name: m.name ?? null,
      side: m.side ?? null,
      side_name: m.side_name ?? null,
      parsed_sides: parsedSides,
      token_name: tokenName,
      question_name: questionName,
      question_description: questionRules,
      display_name: displayName,
      short_name: shortName,
      mid_price: liveMidPrice ?? m.mid_price ?? null,
      volume_24h: m.volume_24h ?? null,
      total_volume: m.total_volume ?? null,
      total_trades: totalTrades,
      open_interest: m.open_interest ?? null,
      is_settled: settled || (!m.coin || m.coin.trim() === ''),
      settled_at: asUtcIso(m.settled_at ?? (settled ? m.block_time : null)),
      expiry: effectiveExpiry,
      period: effectivePeriod,
      target_price: effectiveTargetPrice,
    };
  });
}

/**
 * A row with nothing of its own: HypeDexer lists each traded side coin
 * `#(10N + side)` as a placeholder row (name = coin, no description, no
 * sides, never settled) and keeps the market on outcome N's row.
 */
export function isBareMarketRow(m: RawHip4Market): boolean {
  const name = (m.name ?? '').trim();
  return (
    !(m.description ?? '').trim() &&
    (!name || name === (m.coin ?? '').trim()) &&
    parseSideSpecs(m.side_specs) == null &&
    !(m.class ?? '').trim()
  );
}

/**
 * Outcome N's enriched market seen from one of its traded coins,
 * `#(10N + side)`: the coin Hyperliquid prices and HypeDexer files fills under.
 */
export function toSideCoinMarket(
  market: Hip4MarketEnriched,
  side: number,
  midPrices?: Map<string, number>
): Hip4MarketEnriched {
  const outcomeId = market.outcome_id * 10 + side;
  const coin = `#${outcomeId}`;
  return {
    ...market,
    outcome_id: outcomeId,
    coin,
    side,
    side_name: market.parsed_sides?.[side]?.name ?? null,
    mid_price: midPrices?.get(coin) ?? null,
  };
}

/**
 * Group enriched markets by question_id; a market with a null question_id is
 * returned as a question of its own (`standaloneQuestion`) so the frontend
 * treats everything uniformly as a question-with-outcomes card. `midPrices`
 * (Hyperliquid allMids) prices a standalone market's sides.
 */
export function buildQuestionsWithOutcomes(
  enrichedMarkets: Hip4MarketEnriched[],
  questions: RawHip4Question[],
  midPrices?: Map<string, number>
): Hip4QuestionWithOutcomes[] {
  const questionIdx = indexQuestions(questions);
  const groups = new Map<number, Hip4MarketEnriched[]>();
  const singletons: Hip4MarketEnriched[] = [];

  for (const m of enrichedMarkets) {
    if (m.question_id != null) {
      const bucket = groups.get(m.question_id);
      if (bucket) bucket.push(m);
      else groups.set(m.question_id, [m]);
    } else {
      singletons.push(m);
    }
  }

  const grouped: Hip4QuestionWithOutcomes[] = [];

  for (const [questionId, outcomes] of groups.entries()) {
    const question = questionIdx.get(questionId);
    const totalVolume = outcomes.reduce((s, o) => s + (o.total_volume ?? 0), 0);
    const allSettled = outcomes.length > 0 && outcomes.every((o) => o.is_settled);
    const hasSettledNamed = (question?.settled_named_outcomes?.length ?? 0) > 0;
    const status: 'live' | 'settled' = allSettled || hasSettledNamed ? 'settled' : 'live';

    const first = outcomes[0];
    const resolvedAt = outcomes
      .map((o) => o.settled_at)
      .filter((v): v is string => typeof v === 'string')
      .sort()
      .pop() ?? null;

    grouped.push({
      question_id: questionId,
      // Titled in enrichMarkets from the same question (template / bucket rendered).
      title: first?.question_name ?? null,
      description: first?.question_description ?? question?.description ?? null,
      class: first?.class ?? null,
      underlying: first?.underlying ?? null,
      outcome_count: outcomes.length,
      total_volume: totalVolume,
      created_at: null,
      resolved_at: resolvedAt,
      status,
      singleton_outcome_id: null,
      expiry: first?.expiry ?? null,
      period: first?.period ?? null,
      target_price: first?.target_price ?? null,
      outcomes: outcomes.map(toQuestionOutcome),
    });
  }

  for (const m of singletons) {
    if (m.outcome_id < 10) continue; // skip template/metadata markets
    grouped.push(standaloneQuestion(m, midPrices));
  }

  grouped.sort((a, b) => b.total_volume - a.total_volume);
  return grouped;
}

/**
 * A market with no question, as a question of its own: one outcome per side,
 * both on its raw outcome id N and told apart by their coin `#(10N + side)`,
 * the coin Hyperliquid prices and HypeDexer files fills under. Raw outcomes
 * 10N and 10N + 1 are two unrelated markets, never the Yes and No of one.
 */
function standaloneQuestion(
  m: Hip4MarketEnriched,
  midPrices?: Map<string, number>
): Hip4QuestionWithOutcomes {
  const sides: ParsedSide[] = m.parsed_sides?.length
    ? m.parsed_sides.slice(0, 2)
    : [{ name: 'Yes' }, { name: 'No' }];
  const outcomes: Hip4QuestionOutcome[] = sides.map((s, side) => {
    const sideMarket = toSideCoinMarket(m, side, midPrices);
    return {
      outcome_id: m.outcome_id,
      side_name: s.name,
      display_name: s.name,
      mid_price: sideMarket.mid_price,
      volume_24h: null,
      // The market's volume is the question's: no split per side.
      total_volume: null,
      open_interest: null,
      is_settled: m.is_settled,
      settled_at: m.settled_at,
      coin: sideMarket.coin ?? undefined,
    };
  });

  return {
    question_id: null,
    title: m.display_name,
    description: m.question_description,
    class: m.class,
    underlying: m.underlying,
    outcome_count: outcomes.length,
    total_volume: m.total_volume ?? 0,
    created_at: null,
    resolved_at: m.settled_at,
    status: m.is_settled ? 'settled' : 'live',
    singleton_outcome_id: m.outcome_id,
    expiry: m.expiry,
    period: m.period,
    target_price: m.target_price,
    outcomes,
  };
}

function toQuestionOutcome(m: Hip4MarketEnriched): Hip4QuestionOutcome {
  return {
    outcome_id: m.outcome_id,
    side_name: m.side_name,
    display_name: m.display_name,
    mid_price: m.mid_price,
    volume_24h: m.volume_24h,
    total_volume: m.total_volume,
    open_interest: m.open_interest,
    is_settled: m.is_settled,
    settled_at: m.settled_at,
  };
}

function parseSettlePrice(details: string | null | undefined): number | null {
  if (!details) return null;
  const m = details.match(/price:(\d+\.?\d*)/);
  return m ? parseFloat(m[1]) : null;
}

function deriveWinnerSide(fraction: number | null | undefined): number | null {
  if (fraction == null) return null;
  // settle_fraction >= 0.5 → YES outcome resolved → winner = YES (side 0)
  // settle_fraction < 0.5  → NO outcome resolved  → winner = NO  (side 1)
  return fraction >= 0.5 ? 0 : 1;
}

/**
 * Enrich settlements with `winner_name` and `question_name` by cross-referencing
 * the enriched markets map (keyed by outcome_id) and the questions map.
 *
 * Supports both legacy fields (settled_at, winner_side, settled_px) and
 * mainnet fields (block_time, settle_fraction, details).
 */
export function enrichSettlements(
  settlements: RawHip4Settlement[],
  enrichedMarkets: Hip4MarketEnriched[],
  questions: RawHip4Question[]
): Hip4SettlementEnriched[] {
  const marketIdx = new Map<number, Hip4MarketEnriched>();
  for (const m of enrichedMarkets) marketIdx.set(m.outcome_id, m);
  const questionIdx = indexQuestions(questions);

  return settlements.map((s) => {
    const market = marketIdx.get(s.outcome_id);
    const questionId = market?.question_id ?? null;
    const question = questionId != null ? questionIdx.get(questionId) : undefined;

    // Mainnet: block_time replaces settled_at; settle_fraction replaces winner_side;
    // details ("price:78212.4") replaces settled_px.
    const settledAt = asUtcIso(s.settled_at ?? s.block_time) ?? '';
    const settledPx = s.settled_px ?? parseSettlePrice(s.details);
    const winnerSide = s.winner_side ?? deriveWinnerSide(s.settle_fraction);

    let winnerName: string | null = null;

    const settledNamed = question?.settled_named_outcomes ?? [];
    if (settledNamed.length > 0) {
      const winnerOutcomeId = settledNamed[0];
      const winnerMarket = marketIdx.get(winnerOutcomeId);
      if (winnerMarket) winnerName = winnerMarket.display_name;
    }

    if (!winnerName && market?.parsed_sides && winnerSide != null) {
      winnerName = market.parsed_sides[winnerSide]?.name ?? null;
    }

    if (!winnerName && winnerSide != null) {
      winnerName = winnerSide === 0 ? 'Yes' : 'No';
    }

    // The market's question title is the question's name rendered (template,
    // price bucket), so a raw "template:…" or "Recurring" never shows.
    const questionName = market?.question_name || market?.display_name || null;

    return {
      outcome_id: s.outcome_id,
      coin: s.coin ?? market?.coin ?? null,
      settled_px: settledPx,
      settle_fraction: s.settle_fraction ?? null,
      settled_at: settledAt,
      winner_side: winnerSide,
      tx_hash: s.tx_hash ?? null,
      winner_name: winnerName,
      question_name: questionName,
    };
  });
}
