/** One page of rows from a source this backend owns. */
export interface LocalSourcePage {
  rows: Record<string, unknown>[];
  totalCount: number | null;
  /** False when the source hands back everything at once and cannot page. */
  pageable: boolean;
}

export interface LocalSourceRequest {
  params: Record<string, string>;
  limit: number;
  /** 1-based: every local service paginates by page, not offset. */
  page: number;
}

export type LocalSourceResolver = (request: LocalSourceRequest) => Promise<LocalSourcePage>;

/** Anything not a plain object cannot become a CSV row. */
function asRows(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (row): row is Record<string, unknown> =>
      row !== null && typeof row === 'object' && !Array.isArray(row)
  );
}

/** Reads `T[]`, `{data: T[]}` or `{data: T[], pagination: {total}}` alike. */
function paginated(value: unknown): { rows: Record<string, unknown>[]; totalCount: number | null } {
  if (Array.isArray(value)) return { rows: asRows(value), totalCount: value.length };
  if (value !== null && typeof value === 'object') {
    const envelope = value as Record<string, unknown>;
    const rows = asRows(envelope.data);
    const pagination = envelope.pagination as { total?: number } | undefined;
    const total =
      typeof pagination?.total === 'number'
        ? pagination.total
        : typeof envelope.total === 'number'
          ? (envelope.total as number)
          : null;
    return { rows, totalCount: total };
  }
  return { rows: [], totalCount: null };
}

/**
 * Query params in the shape Express would deliver them: the Prisma-backed
 * services validate with `z.string().transform(parseInt)`, which rejects a
 * genuine number.
 */
function asQuery(limit: number, page: number): Record<string, string> {
  return { limit: String(limit), page: String(page) };
}

/**
 * Datasets served by this backend rather than by HypeDexer.
 *
 * They exist because the app's own tables (spot, perp, vaults, validators, the
 * project directory, the wiki) are the ones people actually look at, and a
 * catalog built only from the indexer offered none of them.
 *
 * Every service is imported lazily, inside its resolver. Importing them at
 * module scope pulled the whole service graph — including three that construct
 * themselves on load and boot a Prisma client — into anything that merely
 * imports the export service, which is a CSV writer with no business touching
 * the database layer.
 *
 * Keyed by dataset id, kept out of the manifest so the manifest stays pure data
 * that can be serialised to the client.
 */
export const LOCAL_SOURCES: Record<string, LocalSourceResolver> = {
  'spot-markets': async ({ limit, page }) => {
    const { SpotAssetContextService } = await import('../spot/marketData.service');
    const result = await SpotAssetContextService.getInstance().getMarketsData({ limit, page });
    return { ...paginated(result), pageable: true };
  },

  'perp-markets': async ({ limit, page }) => {
    const { PerpAssetContextService } = await import('../perp/perpAssetContext.service');
    const result = await PerpAssetContextService.getInstance().getPerpMarketsData({ limit, page });
    return { ...paginated(result), pageable: true };
  },

  vaults: async ({ limit, page, params }) => {
    const { VaultsService } = await import('../vault/vaults.service');
    const result = await VaultsService.getInstance().getVaultsList({
      limit,
      page,
      ...(params.includeClosed === 'true' ? { includeClosed: true } : {}),
    });
    return { ...paginated(result), pageable: true };
  },

  validators: async () => {
    const { ValidatorSummariesService } = await import('../staking/validator.service');
    // Returns the whole set in one call, so it is served as a single page.
    const result = await ValidatorSummariesService.getInstance().getAllValidatorsDetails();
    const rows = asRows(result?.validators);
    return { rows, totalCount: rows.length, pageable: false };
  },

  'unstaking-queue': async ({ limit, page }) => {
    const { UnstakingService } = await import('../staking/unstaking.service');
    const result = await UnstakingService.getInstance().getUnstakingQueue({ limit, page });
    return { ...paginated(result), pageable: true };
  },

  'xp-leaderboard': async ({ limit, page }) => {
    const { LeaderboardService } = await import('../leaderboard/leaderboard.service');
    const result = await LeaderboardService.getInstance().getLeaderboard({ limit, page });
    return { ...paginated(result), pageable: true };
  },

  'fees-history': async () => {
    const { FeesService } = await import('../fees/fees.service');
    const result = await FeesService.getInstance().getRawFeesDataWithConversion();
    const rows = asRows(result);
    return { rows, totalCount: rows.length, pageable: false };
  },

  projects: async ({ limit, page }) => {
    const { ProjectService } = await import('../project/project.service');
    // Strings, not numbers: these schemas are written for Express query params
    // (`z.string().transform(parseInt)`) and reject a real number.
    const result = await new ProjectService().getAll(asQuery(limit, page));
    return { ...paginated(result), pageable: true };
  },

  'wiki-resources': async ({ limit, page }) => {
    const { EducationalResourceService } = await import(
      '../educational/educational-resource.service'
    );
    const result = await new EducationalResourceService().getPublicResources(asQuery(limit, page));
    return { ...paginated(result), pageable: true };
  },

  'public-readlists': async ({ limit, page }) => {
    const { ReadListService } = await import('../readlist/readlist.service');
    const result = await new ReadListService().getPublicLists(asQuery(limit, page));
    return { ...paginated(result), pageable: true };
  },
};

export function getLocalSource(datasetId: string): LocalSourceResolver | undefined {
  return LOCAL_SOURCES[datasetId];
}
