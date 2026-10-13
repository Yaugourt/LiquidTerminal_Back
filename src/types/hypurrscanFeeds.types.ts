/**
 * Hypurrscan feeds the backend relays to the browser as sent (pastAuctionsPerp,
 * deploys, globalAliases). The shapes mirror what the front reads and
 * transforms; nothing is reshaped here.
 */

interface PastAuctionAssetRequest {
  coin: string;
  szDecimals: number;
  oraclePx: string;
  marginTableId: number;
  onlyIsolated: boolean;
}

interface PastAuctionSchema {
  fullName: string;
  collateralToken: number;
  oracleUpdater: string | null;
}

/** An entry with `action` (the current format; `gasUsed` can be negative). */
export interface PerpAuctionEntry {
  time: number;
  user: string;
  action: {
    type: string;
    registerAsset?: {
      maxGas: number | null;
      assetRequest: PastAuctionAssetRequest;
      dex: string;
      schema: PastAuctionSchema | null;
    };
  };
  block: number;
  hash: string;
  error: string | null;
  gasUsed?: number;
}

/** The first entries of the feed predate `action`. */
export interface LegacyPerpAuctionEntry {
  time: number;
  deployer: string;
  name: string;
  deployGas: string;
}

export type HypurrscanPastAuctionPerp = PerpAuctionEntry | LegacyPerpAuctionEntry;

/** One spot deploy action (the latest 50, newest first). */
export interface HypurrscanDeploy {
  time: number;
  user: string;
  action: {
    type: string;
    registerToken2?: {
      spec?: { name: string; szDecimals: number; weiDecimals: number };
      maxGas?: number;
    };
    [key: string]: unknown;
  };
  block: number;
  hash: string;
  error: string | null;
}

/** Lowercased address → label. */
export type HypurrscanGlobalAliases = Record<string, string>;
