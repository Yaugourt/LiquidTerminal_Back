import { DefiLlamaClient } from '../../clients/defillama/defillama.client';
import { cacheService } from '../../core/cache.service';
import { prismaContent } from '../../core/prisma.content.service';
import { DEFILLAMA_CACHE_KEYS, DEFILLAMA_TTL } from '../../constants/defillama.cache';
import {
  ChainRankedEntry,
  DefiLlamaChainStats,
  DefiLlamaTvlHistory,
  HlSnapshotEntry,
  ProjectContext,
  ProjectListMetric,
  ProjectPeer,
  ProjectPosition,
  SeriesPoint,
} from '../../types/defillama-context.types';
import {
  DefiLlamaChainOverview,
  DefiLlamaProtocolListItem,
  DefiLlamaTvlPoint,
} from '../../types/defillama.types';

const HL_CHAIN = 'Hyperliquid L1';
const PEERS_LIMIT = 5;

/** "solv-protocol" → "Solv Protocol" (display name for parents absent from /protocols). */
function titleCaseSlug(slug: string): string {
  return slug
    .split('-')
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(' ');
}

/** Extract the bare parent slug from either `parentProtocolSlug` or `parentProtocol` ("parent#x"). */
function parentSlugOf(p: DefiLlamaProtocolListItem): string | null {
  if (typeof p.parentProtocolSlug === 'string' && p.parentProtocolSlug) return p.parentProtocolSlug;
  if (typeof p.parentProtocol === 'string' && p.parentProtocol.startsWith('parent#')) {
    return p.parentProtocol.slice('parent#'.length);
  }
  return null;
}

/** Linked project row used to make peers clickable and to build DB-category peers. */
interface LinkedProjectRow {
  id: number;
  title: string;
  logo: string;
  defillamaSlug: string;
  categoryIds: number[];
}

/**
 * Hyperliquid-centric context on top of the DefiLlama proxy: chain banner
 * figures, per-project position (rank, share, fees rank) and peer groups.
 * All chain-scoped numbers come from `chainTvls["Hyperliquid L1"]`; the chain
 * TVL denominator always comes from `/v2/chains` (no hand-rolled sums, they
 * double-count the bridge).
 */
export class DefiLlamaContextService {
  private static instance: DefiLlamaContextService;
  private readonly client = DefiLlamaClient.getInstance();

  public static getInstance(): DefiLlamaContextService {
    if (!DefiLlamaContextService.instance) {
      DefiLlamaContextService.instance = new DefiLlamaContextService();
    }
    return DefiLlamaContextService.instance;
  }

  // ── Reduced Hyperliquid snapshot (parent-aggregated) ────────────────────

  public getHlSnapshot(): Promise<HlSnapshotEntry[]> {
    return cacheService.getOrSet(
      DEFILLAMA_CACHE_KEYS.hlSnapshot,
      () => this.buildHlSnapshot(),
      DEFILLAMA_TTL.hlSnapshot
    );
  }

  private async buildHlSnapshot(): Promise<HlSnapshotEntry[]> {
    const protocols = await this.client.getProtocols();

    interface Group {
      slug: string;
      members: DefiLlamaProtocolListItem[];
      hlTvl: number;
      hlBorrowed: number;
      globalTvl: number;
    }
    const groups = new Map<string, Group>();

    for (const p of protocols) {
      const hlTvl = p.chainTvls?.[HL_CHAIN];
      if (typeof hlTvl !== 'number' || hlTvl <= 0) continue;
      const key = parentSlugOf(p) ?? p.slug ?? p.name.toLowerCase();
      const group = groups.get(key) ?? { slug: key, members: [], hlTvl: 0, hlBorrowed: 0, globalTvl: 0 };
      group.members.push(p);
      group.hlTvl += hlTvl;
      group.hlBorrowed += p.chainTvls?.[`${HL_CHAIN}-borrowed`] ?? 0;
      group.globalTvl += p.tvl ?? 0;
      groups.set(key, group);
    }

    const entries: HlSnapshotEntry[] = [];
    for (const g of groups.values()) {
      const top = [...g.members].sort(
        (a, b) => (b.chainTvls?.[HL_CHAIN] ?? 0) - (a.chainTvls?.[HL_CHAIN] ?? 0)
      )[0];
      const monoChain = g.members.every(
        (m) => Array.isArray(m.chains) && m.chains.every((c) => c === HL_CHAIN)
      );
      // Weighted 7d change, only meaningful when every member lives on HL alone.
      let change7d: number | null = null;
      if (monoChain && g.hlTvl > 0) {
        let weighted = 0;
        let weight = 0;
        for (const m of g.members) {
          if (typeof m.change_7d === 'number') {
            const w = m.chainTvls?.[HL_CHAIN] ?? 0;
            weighted += m.change_7d * w;
            weight += w;
          }
        }
        change7d = weight > 0 ? weighted / weight : null;
      }
      // Multi-child parents get a name derived from the parent slug ("Solv
      // Protocol"); single-child groups keep the child's real name.
      const isParentGroup = g.members.some((m) => parentSlugOf(m) === g.slug);
      entries.push({
        slug: g.slug,
        name: isParentGroup && g.members.length > 1 ? titleCaseSlug(g.slug) : top.name,
        category: top.category ?? null,
        hlTvl: g.hlTvl,
        hlBorrowed: g.hlBorrowed > 0 ? g.hlBorrowed : null,
        globalTvl: g.globalTvl,
        change7d,
        monoChain,
        logo: top.logo ?? null,
        memberSlugs: g.members.map((m) => m.slug).filter((s): s is string => typeof s === 'string'),
      });
    }

    return entries.sort((a, b) => b.hlTvl - a.hlTvl);
  }

  // ── Chain-wide rankings (fees / DEX volume), parent-aggregated ──────────

  private getFeesRanking(): Promise<{ chainTotal24h: number | null; entries: ChainRankedEntry[] }> {
    return cacheService.getOrSet(
      DEFILLAMA_CACHE_KEYS.hlFeesRanking,
      async () => this.reduceOverview(await this.client.getChainFeesOverview(HL_CHAIN)),
      DEFILLAMA_TTL.ranking
    );
  }

  private getVolumeRanking(): Promise<{ chainTotal24h: number | null; entries: ChainRankedEntry[] }> {
    return cacheService.getOrSet(
      DEFILLAMA_CACHE_KEYS.hlVolumeRanking,
      async () => this.reduceOverview(await this.client.getChainDexsOverview(HL_CHAIN)),
      DEFILLAMA_TTL.ranking
    );
  }

  private reduceOverview(overview: DefiLlamaChainOverview): {
    chainTotal24h: number | null;
    entries: ChainRankedEntry[];
  } {
    interface Group { slug: string; name: string; total24h: number; memberSlugs: string[] }
    const groups = new Map<string, Group>();
    for (const p of overview.protocols ?? []) {
      const total = typeof p.total24h === 'number' ? p.total24h : 0;
      const own = p.slug ?? p.name.toLowerCase();
      const parent =
        typeof p.parentProtocol === 'string' && p.parentProtocol.startsWith('parent#')
          ? p.parentProtocol.slice('parent#'.length)
          : null;
      const key = parent ?? own;
      const group = groups.get(key) ?? {
        slug: key,
        name: parent ? titleCaseSlug(parent) : p.displayName ?? p.name,
        total24h: 0,
        memberSlugs: [],
      };
      group.total24h += total;
      group.memberSlugs.push(own);
      groups.set(key, group);
    }
    const entries = [...groups.values()]
      .filter((g) => g.total24h > 0)
      .sort((a, b) => b.total24h - a.total24h);
    return { chainTotal24h: overview.total24h ?? null, entries };
  }

  // ── Chain banner ─────────────────────────────────────────────────────────

  public async getChainStats(): Promise<DefiLlamaChainStats> {
    const [chains, fees, volume, snapshot] = await Promise.all([
      this.client
        .getChains()
        .then((cs) => cs.find((c) => c.name === HL_CHAIN)?.tvl ?? null)
        .catch(() => null),
      this.getFeesRanking().catch(() => null),
      this.getVolumeRanking().catch(() => null),
      this.getHlSnapshot().catch(() => [] as HlSnapshotEntry[]),
    ]);
    return {
      tvl: chains,
      fees24h: fees?.chainTotal24h ?? null,
      volumeDex24h: volume?.chainTotal24h ?? null,
      protocolsTracked: snapshot.length,
    };
  }

  // ── Linked projects (slug → project row) ─────────────────────────────────

  private getLinkedProjects(): Promise<LinkedProjectRow[]> {
    return cacheService.getOrSet(
      DEFILLAMA_CACHE_KEYS.linkedProjects,
      async () => {
        const rows = await prismaContent.project.findMany({
          where: { defillamaSlug: { not: null } },
          select: {
            id: true,
            title: true,
            logo: true,
            defillamaSlug: true,
            categories: { select: { categoryId: true } },
          },
        });
        return rows.map((r) => ({
          id: r.id,
          title: r.title,
          logo: r.logo,
          defillamaSlug: r.defillamaSlug as string,
          categoryIds: r.categories.map((c) => c.categoryId),
        }));
      },
      DEFILLAMA_TTL.linkedProjects
    );
  }

  // ── Per-project context ──────────────────────────────────────────────────

  public async getProjectContext(project: {
    id: number;
    defillamaSlug: string | null;
    categoryIds: number[];
  }): Promise<ProjectContext> {
    const [chain, snapshot, linked] = await Promise.all([
      this.getChainStats(),
      this.getHlSnapshot(),
      this.getLinkedProjects().catch(() => [] as LinkedProjectRow[]),
    ]);
    const projectIdBySlug = new Map<string, LinkedProjectRow>();
    for (const row of linked) projectIdBySlug.set(row.defillamaSlug, row);

    const entryFor = (slug: string): HlSnapshotEntry | undefined =>
      snapshot.find((e) => e.slug === slug || e.memberSlugs.includes(slug));

    const slug = project.defillamaSlug;
    const entry = slug ? entryFor(slug) : undefined;

    if (slug && entry) {
      const position = await this.buildPosition(slug, entry, snapshot, chain);
      const peers = this.buildCategoryPeers(entry, snapshot, projectIdBySlug, project.id);
      return { chain, position, peers, peersScope: peers.length > 0 ? 'defillama-category' : 'none' };
    }

    // Unlinked (or linked without HL deployment): peers = linked projects of
    // the same DB category, ranked by their HL TVL.
    const peers = this.buildDbPeers(project, snapshot, linked);
    return { chain, position: null, peers, peersScope: peers.length > 0 ? 'db-category' : 'none' };
  }

  private async buildPosition(
    slug: string,
    entry: HlSnapshotEntry,
    snapshot: HlSnapshotEntry[],
    chain: DefiLlamaChainStats
  ): Promise<ProjectPosition> {
    const inCategory = entry.category
      ? snapshot.filter((e) => e.category === entry.category)
      : [];
    const categoryTvl = inCategory.reduce((acc, e) => acc + e.hlTvl, 0);
    const categoryRank = entry.category
      ? inCategory.findIndex((e) => e.slug === entry.slug) + 1
      : null;

    const matches = (r: { slug: string; memberSlugs: string[] }): boolean =>
      r.slug === entry.slug || r.memberSlugs.includes(slug) || entry.memberSlugs.some((m) => r.memberSlugs.includes(m));

    const [fees, volume] = await Promise.all([
      this.getFeesRanking().catch(() => null),
      this.getVolumeRanking().catch(() => null),
    ]);
    const feesIdx = fees ? fees.entries.findIndex(matches) : -1;
    const volumeIdx = volume ? volume.entries.findIndex(matches) : -1;

    return {
      slug: entry.slug,
      hlTvl: entry.hlTvl,
      hlBorrowed: entry.hlBorrowed,
      shareOfChainPct: chain.tvl && chain.tvl > 0 ? (entry.hlTvl / chain.tvl) * 100 : null,
      category: entry.category,
      categoryRank: categoryRank && categoryRank > 0 ? categoryRank : null,
      categorySize: entry.category ? inCategory.length : null,
      categoryTvl: entry.category ? categoryTvl : null,
      shareOfCategoryPct: categoryTvl > 0 ? (entry.hlTvl / categoryTvl) * 100 : null,
      change7d: entry.change7d,
      monoChain: entry.monoChain,
      fees24h: feesIdx >= 0 ? fees!.entries[feesIdx].total24h : null,
      feesRank24h: feesIdx >= 0 ? feesIdx + 1 : null,
      feesRankCount: fees ? fees.entries.length : null,
      volume24h: volumeIdx >= 0 ? volume!.entries[volumeIdx].total24h : null,
      volumeRank24h: volumeIdx >= 0 ? volumeIdx + 1 : null,
      volumeRankCount: volume ? volume.entries.length : null,
    };
  }

  private buildCategoryPeers(
    entry: HlSnapshotEntry,
    snapshot: HlSnapshotEntry[],
    projectIdBySlug: Map<string, { id: number; title: string; logo: string }>,
    currentProjectId: number
  ): ProjectPeer[] {
    if (!entry.category) return [];
    const inCategory = snapshot.filter((e) => e.category === entry.category);
    const categoryTvl = inCategory.reduce((acc, e) => acc + e.hlTvl, 0);
    const top = inCategory.slice(0, PEERS_LIMIT);
    // Keep the current project visible even when it sits below the top N.
    if (!top.some((e) => e.slug === entry.slug)) {
      top[top.length - 1] = entry;
    }
    return top.map((e) => {
      const linkedRow =
        projectIdBySlug.get(e.slug) ??
        e.memberSlugs.map((m) => projectIdBySlug.get(m)).find((r) => r !== undefined);
      const isCurrent = e.slug === entry.slug;
      return {
        rank: inCategory.findIndex((x) => x.slug === e.slug) + 1,
        name: linkedRow?.title ?? e.name,
        slug: e.slug,
        hlTvl: e.hlTvl,
        shareOfCategoryPct: categoryTvl > 0 ? (e.hlTvl / categoryTvl) * 100 : null,
        change7d: e.change7d,
        projectId: isCurrent ? currentProjectId : linkedRow?.id ?? null,
        logo: linkedRow?.logo ?? e.logo,
        isCurrent,
      };
    });
  }

  private buildDbPeers(
    project: { id: number; categoryIds: number[] },
    snapshot: HlSnapshotEntry[],
    linked: LinkedProjectRow[]
  ): ProjectPeer[] {
    if (project.categoryIds.length === 0) return [];
    const sameCategory = linked.filter(
      (row) => row.id !== project.id && row.categoryIds.some((c) => project.categoryIds.includes(c))
    );
    const withTvl = sameCategory
      .map((row) => {
        const entry = snapshot.find(
          (e) => e.slug === row.defillamaSlug || e.memberSlugs.includes(row.defillamaSlug)
        );
        return entry ? { row, entry } : null;
      })
      .filter((x): x is { row: LinkedProjectRow; entry: HlSnapshotEntry } => x !== null)
      .sort((a, b) => b.entry.hlTvl - a.entry.hlTvl)
      .slice(0, PEERS_LIMIT);

    return withTvl.map(({ row, entry }, i) => ({
      rank: i + 1,
      name: row.title,
      slug: entry.slug,
      hlTvl: entry.hlTvl,
      shareOfCategoryPct: null,
      change7d: entry.change7d,
      projectId: row.id,
      logo: row.logo,
      isCurrent: false,
    }));
  }

  // ── Batch map for the projects list (cards + TVL sort) ──────────────────

  /**
   * One row per linked project: HL TVL, chain/category ranks and fees rank,
   * everything the list page needs to decorate cards and sort — in one call.
   */
  public async getProjectsListMetrics(): Promise<ProjectListMetric[]> {
    const [snapshot, linked, fees] = await Promise.all([
      this.getHlSnapshot(),
      this.getLinkedProjects().catch(() => [] as LinkedProjectRow[]),
      this.getFeesRanking().catch(() => null),
    ]);

    const categoryRankOf = (entry: HlSnapshotEntry): number | null => {
      if (!entry.category) return null;
      const idx = snapshot
        .filter((e) => e.category === entry.category)
        .findIndex((e) => e.slug === entry.slug);
      return idx >= 0 ? idx + 1 : null;
    };

    return linked.map((row) => {
      const entry = snapshot.find(
        (e) => e.slug === row.defillamaSlug || e.memberSlugs.includes(row.defillamaSlug)
      );
      const feesIdx = fees
        ? fees.entries.findIndex(
            (r) =>
              r.slug === (entry?.slug ?? row.defillamaSlug) ||
              r.memberSlugs.includes(row.defillamaSlug) ||
              (entry?.memberSlugs.some((m) => r.memberSlugs.includes(m)) ?? false)
          )
        : -1;
      return {
        projectId: row.id,
        slug: row.defillamaSlug,
        hlTvl: entry?.hlTvl ?? null,
        globalTvl: entry?.globalTvl ?? null,
        hlRank: entry ? snapshot.findIndex((e) => e.slug === entry.slug) + 1 : null,
        category: entry?.category ?? null,
        categoryRank: entry ? categoryRankOf(entry) : null,
        fees24h: feesIdx >= 0 ? fees!.entries[feesIdx].total24h : null,
        feesRank24h: feesIdx >= 0 ? feesIdx + 1 : null,
        change7d: entry?.change7d ?? null,
      };
    });
  }

  // ── Light TVL history ────────────────────────────────────────────────────

  public getTvlHistory(slug: string): Promise<DefiLlamaTvlHistory> {
    return cacheService.getOrSet(
      DEFILLAMA_CACHE_KEYS.tvlHistory(slug),
      () => this.buildTvlHistory(slug),
      DEFILLAMA_TTL.tvlHistory
    );
  }

  private async buildTvlHistory(slug: string): Promise<DefiLlamaTvlHistory> {
    const detail = await this.client.getProtocol(slug);
    const toSeries = (points: DefiLlamaTvlPoint[] | undefined): SeriesPoint[] | null => {
      if (!Array.isArray(points) || points.length === 0) return null;
      return points
        .filter((p) => typeof p.date === 'number' && typeof p.totalLiquidityUSD === 'number')
        .map((p) => ({ t: p.date * 1000, v: p.totalLiquidityUSD }));
    };
    return {
      slug,
      hl: toSeries(detail.chainTvls?.[HL_CHAIN]?.tvl),
      global: toSeries(detail.tvl),
    };
  }
}
