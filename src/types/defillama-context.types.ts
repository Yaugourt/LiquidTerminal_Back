/**
 * Hyperliquid-centric context computed from DefiLlama free data.
 * Everything here is chain-scoped ("on Hyperliquid L1") — global figures live
 * in the per-project overview (`defillama.types.ts`), never mixed in.
 */

export interface SeriesPoint {
  t: number; // epoch ms
  v: number; // USD
}

/**
 * One protocol (parent-aggregated) present on Hyperliquid L1.
 * Built by reducing DefiLlama `/protocols` (8+ MB) to the HL subset.
 */
export interface HlSnapshotEntry {
  /** Group key: DefiLlama parent slug when the protocol is split into children, else the protocol slug. */
  slug: string;
  name: string;
  /** Category of the largest HL child (parents carry no category upstream). */
  category: string | null;
  hlTvl: number;
  hlBorrowed: number | null;
  globalTvl: number;
  /** 7d change, only when every member deploys solely on Hyperliquid L1 (global change is misleading otherwise). */
  change7d: number | null;
  monoChain: boolean;
  logo: string | null;
  /** Child slugs folded into this entry (used to resolve DB slugs stored at child level). */
  memberSlugs: string[];
}

/** Chain-level banner figures. */
export interface DefiLlamaChainStats {
  tvl: number | null;
  fees24h: number | null;
  volumeDex24h: number | null;
  protocolsTracked: number;
}

/** One row of a chain-wide ranking (fees or DEX volume), parent-aggregated. */
export interface ChainRankedEntry {
  slug: string;
  name: string;
  total24h: number;
  memberSlugs: string[];
}

export interface ProjectPeer {
  rank: number;
  name: string;
  slug: string;
  hlTvl: number;
  /** Share of the peer group's summed HL TVL (category view). */
  shareOfCategoryPct: number | null;
  change7d: number | null;
  /** Set when the peer is one of our own projects (makes the row clickable). */
  projectId: number | null;
  logo: string | null;
  isCurrent: boolean;
}

export interface ProjectPosition {
  slug: string;
  hlTvl: number;
  hlBorrowed: number | null;
  shareOfChainPct: number | null;
  category: string | null;
  categoryRank: number | null;
  categorySize: number | null;
  categoryTvl: number | null;
  shareOfCategoryPct: number | null;
  change7d: number | null;
  monoChain: boolean;
  fees24h: number | null;
  feesRank24h: number | null;
  feesRankCount: number | null;
  volume24h: number | null;
  volumeRank24h: number | null;
  volumeRankCount: number | null;
}

export interface ProjectContext {
  chain: DefiLlamaChainStats;
  /** Null when the project has no DefiLlama slug or no Hyperliquid deployment. */
  position: ProjectPosition | null;
  /** DefiLlama category peers when positioned; same-DB-category linked projects otherwise. */
  peers: ProjectPeer[];
  /** Label of the peer group ("Lending on Hyperliquid" vs "More in DEFI on LiquidTerminal"). */
  peersScope: 'defillama-category' | 'db-category' | 'none';
}

/** Light TVL history extracted from `/protocol/{slug}` (tokens stripped). */
export interface DefiLlamaTvlHistory {
  slug: string;
  /** Hyperliquid L1 daily series, null when the protocol has no HL deployment. */
  hl: SeriesPoint[] | null;
  /** All-chains daily series. */
  global: SeriesPoint[] | null;
}
