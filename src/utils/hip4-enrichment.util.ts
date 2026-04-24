/**
 * Pure helpers that turn raw HypeDexer HIP-4 payloads into shapes consumable by
 * the frontend without additional client-side cross-referencing.
 *
 * No I/O, no caching — just shape transformations.
 */

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
  expiry?: string | null;
  period?: string | null;
  target_price?: number | null;
  description?: string | null;
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
  coin?: string | null;
  settled_px?: number | null;
  settled_at: string;
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
  outcomes: Hip4QuestionOutcome[];
}

export interface Hip4SettlementEnriched {
  outcome_id: number;
  coin: string | null;
  settled_px: number | null;
  settled_at: string;
  winner_side: number | null;
  tx_hash: string | null;
  winner_name: string | null;
  question_name: string | null;
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
 * 1. Named side from parsed side_specs at the market's side index (multi-outcome custom markets)
 * 2. Question name (markets bound to a question)
 * 3. Outcome token spot_name (HIP-4 token registry)
 * 4. Market.name (HypeDexer's own label, often "Recurring")
 * 5. Market.coin as last-resort identifier (e.g. "#50790")
 */
export function deriveDisplayName(params: {
  parsedSides: ParsedSide[] | null;
  side: number | null;
  questionName: string | null;
  tokenName: string | null;
  marketName: string | null;
  coin: string | null;
}): string {
  const { parsedSides, side, questionName, tokenName, marketName, coin } = params;

  if (parsedSides && side != null && parsedSides[side]?.name) {
    return parsedSides[side].name;
  }
  if (questionName && questionName.trim()) return questionName;
  if (tokenName && tokenName.trim()) return tokenName;
  if (marketName && marketName.trim() && marketName.trim() !== 'Recurring') return marketName;
  return coin ?? '';
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

/** Left-join markets with outcome_tokens + questions and derive display fields. */
export function enrichMarkets(
  markets: RawHip4Market[],
  outcomeTokens: RawHip4OutcomeToken[],
  questions: RawHip4Question[]
): Hip4MarketEnriched[] {
  const tokenIdx = indexOutcomeTokens(outcomeTokens);
  const questionIdx = indexQuestions(questions);

  return markets.map((m) => {
    const parsedSides = parseSideSpecs(m.side_specs);
    const token = tokenIdx.get(m.outcome_id);
    const question = m.question_id != null ? questionIdx.get(m.question_id) : undefined;
    const tokenName = token?.spot_name && token.spot_name.trim() ? token.spot_name : null;
    const questionName = question?.name && question.name.trim() ? question.name : null;

    const displayName = deriveDisplayName({
      parsedSides,
      side: m.side ?? null,
      questionName,
      tokenName,
      marketName: m.name,
      coin: m.coin,
    });

    const totalTrades = m.total_trades ?? m.total_fills ?? null;

    return {
      outcome_id: m.outcome_id,
      question_id: m.question_id ?? null,
      coin: m.coin ?? null,
      class: m.class ?? null,
      class_normalized: normalizeClass(m.class),
      underlying: m.underlying ?? null,
      name: m.name ?? null,
      side: m.side ?? null,
      side_name: m.side_name ?? null,
      parsed_sides: parsedSides,
      token_name: tokenName,
      question_name: questionName,
      question_description: question?.description ?? null,
      display_name: displayName,
      mid_price: m.mid_price ?? null,
      volume_24h: m.volume_24h ?? null,
      total_volume: m.total_volume ?? null,
      total_trades: totalTrades,
      open_interest: m.open_interest ?? null,
      is_settled: Boolean(m.is_settled),
      settled_at: m.settled_at ?? null,
      expiry: m.expiry ?? null,
      period: m.period ?? null,
      target_price: m.target_price ?? null,
    };
  });
}

/**
 * Group enriched markets by question_id; markets with a null question_id are
 * returned as singleton synthetic questions so the frontend treats everything
 * uniformly as a question-with-outcomes card.
 */
export function buildQuestionsWithOutcomes(
  enrichedMarkets: Hip4MarketEnriched[],
  questions: RawHip4Question[]
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
      title: question?.name ?? first?.question_name ?? null,
      description: question?.description ?? first?.question_description ?? null,
      class: first?.class ?? null,
      underlying: first?.underlying ?? null,
      outcome_count: outcomes.length,
      total_volume: totalVolume,
      created_at: null,
      resolved_at: resolvedAt,
      status,
      singleton_outcome_id: null,
      outcomes: outcomes.map(toQuestionOutcome),
    });
  }

  for (const m of singletons) {
    const status: 'live' | 'settled' = m.is_settled ? 'settled' : 'live';
    grouped.push({
      question_id: null,
      title: m.display_name,
      description: m.question_description,
      class: m.class,
      underlying: m.underlying,
      outcome_count: 1,
      total_volume: m.total_volume ?? 0,
      created_at: null,
      resolved_at: m.settled_at,
      status,
      singleton_outcome_id: m.outcome_id,
      outcomes: [toQuestionOutcome(m)],
    });
  }

  grouped.sort((a, b) => b.total_volume - a.total_volume);
  return grouped;
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

/**
 * Enrich settlements with `winner_name` and `question_name` by cross-referencing
 * the enriched markets map (keyed by outcome_id) and the questions map.
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

    let winnerName: string | null = null;

    const settledNamed = question?.settled_named_outcomes ?? [];
    if (settledNamed.length > 0) {
      const winnerOutcomeId = settledNamed[0];
      const winnerMarket = marketIdx.get(winnerOutcomeId);
      if (winnerMarket) winnerName = winnerMarket.display_name;
    }

    if (!winnerName && market?.parsed_sides && s.winner_side != null) {
      winnerName = market.parsed_sides[s.winner_side]?.name ?? null;
    }

    if (!winnerName && s.winner_side != null) {
      if (s.winner_side === 0) winnerName = 'Yes';
      else if (s.winner_side === 1) winnerName = 'No';
    }

    return {
      outcome_id: s.outcome_id,
      coin: s.coin ?? market?.coin ?? null,
      settled_px: s.settled_px ?? null,
      settled_at: s.settled_at,
      winner_side: s.winner_side ?? null,
      tx_hash: s.tx_hash ?? null,
      winner_name: winnerName,
      question_name: question?.name ?? market?.question_name ?? null,
    };
  });
}
