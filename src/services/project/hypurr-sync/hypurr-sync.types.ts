/**
 * Types for the Hypurr Collective ecosystem sync (hypurr.co -> Project / Category, content DB).
 */

/** One project as listed on hypurr.co. Missing values are null, never invented. */
export interface HypurrProject {
  /** Webflow CMS slug, stable id on hypurr.co (/ecosystem-projects/<slug>) */
  slug: string;
  name: string;
  website: string | null;
  twitter: string | null;
  telegram: string | null;
  /** Discord invite (Hypurr lists it in its Telegram field for some projects) */
  discord: string | null;
  /** Webflow CDN logo URL */
  logo: string | null;
  /** Hypurr category tags, as shown on the site (e.g. "Defi / Yields") */
  categories: string[];
  /** Short bio shown on the listing card */
  description: string | null;
  /** Token ticker, only when Hypurr says the token is live ("Yes") */
  ticker: string | null;
  /** hypurr.co project page */
  sourceUrl: string;
}

/** Subset of a Liquid Terminal project the sync reads (public API or content DB). */
export interface LtProject {
  id: number;
  title: string;
  desc: string;
  logo: string;
  token: string | null;
  twitter: string | null;
  telegram: string | null;
  discord: string | null;
  website: string | null;
  categories: string[];
}

export type MatchReason = 'twitter' | 'website' | 'name' | 'loose-name';

export type SyncField = 'website' | 'twitter' | 'telegram' | 'discord' | 'logo' | 'description' | 'token' | 'categories';

export interface FieldDiff {
  field: SyncField;
  lt: string | null;
  hypurr: string | null;
  /** true when LT is empty (or a placeholder) and Hypurr has a value: apply mode fills it */
  fillable: boolean;
}

export interface MatchedProject {
  hypurr: HypurrProject;
  lt: LtProject;
  reason: MatchReason;
  diffs: FieldDiff[];
}

export interface SyncDiff {
  hypurrCount: number;
  ltCount: number;
  matched: MatchedProject[];
  /** On Hypurr, not tracked by LT: apply mode creates them */
  missing: HypurrProject[];
  /** Tracked by LT, not on Hypurr (any more): report only, never deleted */
  ltOnly: LtProject[];
  /** Keys shared by several LT projects, skipped for matching (worth a manual look) */
  ambiguous: { key: string; ltTitles: string[] }[];
}
