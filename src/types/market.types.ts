import { BaseResponse } from './common.types';

// Types de base pour les tokens et marchés
export interface Token {
    name: string;
    szDecimals: number;
    weiDecimals: number;
    index: number;
    tokenId: string;
    isCanonical: boolean;
    evmContract: string | null;
    fullName: string | null;
}

export interface Market {
    name: string;
    tokens: number[];
    index: number;
    isCanonical: boolean;
}

// Types pour les stablecoins bridgés
export interface BridgedUsdcData {
    date: number;
    totalCirculating: {
        peggedUSD: number;
    };
}

// Types pour le contexte spot
export interface SpotContext {
    tokens: Token[];
    universe: Market[];
}

export interface AssetContext {
    dayNtlVlm: string;
    markPx: string;
    midPx: string;
    prevDayPx: string;
    circulatingSupply: string;
    coin: string;
}

export interface MarketData {
    name: string;
    logo: string | null;
    price: number;
    marketCap: number;
    volume: number;
    change24h: number;
    liquidity: number;
    /** Circulating supply on HyperCore: Hyperliquid's figure less `bridgeReserve`. `marketCap` = price × supply. */
    supply: number;
    marketIndex: number;
    tokenId: string;
    /** Quote token of the pair as Hyperliquid names it (USDC, USDH, USDT0, USDE...). */
    quote: string;
    /**
     * Bridge reserve on the token's HyperEVM system address (supply minted there
     * at genesis, or parked there by the token's issuer), which Hyperliquid
     * counts as circulating. Absent when none.
     */
    bridgeReserve?: number;
}

/** One point of Hypurrscan `/spotUSDC`, which sends the whole series as an array. */
export interface SpotUSDCData {
    date?: number;
    lastUpdate: number;
    totalSpotUSDC: number;
    totalCirculating?: {
        peggedUSD: number;
    };
    // New fields added by Hypurrscan
    totalSpotUSDT0?: number;
    totalSpotUSDE?: number;
    totalSpotUSDH?: number;
    USDC_holdersCount?: number;
    USDT0_holdersCount?: number;
    USDE_holdersCount?: number;
    USDH_holdersCount?: number;
    USDC_HIP2?: number;
    USDT0_HIP2?: number;
    USDE_HIP2?: number;
    USDH_HIP2?: number;
}

// Types pour les marchés perpétuels
export interface PerpMarket {
    name: string;
    szDecimals: number;
    maxLeverage: number;
    onlyIsolated?: boolean;
}

export interface PerpAssetContext {
    dayNtlVlm: string;
    funding: string;
    impactPxs: string[];
    markPx: string;
    midPx: string;
    openInterest: string;
    oraclePx: string;
    premium: string;
    prevDayPx: string;
}

export interface PerpMarketData {
    index: number;
    name: string;
    price: number;
    change24h: number;
    volume: number;
    openInterest: number;
    funding: number;
    maxLeverage: number;
    onlyIsolated: boolean;
}

// Types pour les statistiques globales spot (volume, paires, market cap)
export interface SpotGlobalStats {
    totalVolume24h: number;
    totalPairs: number;
    totalMarketCap: number;
    totalSpotUSDC: number;
    totalHIP2: number;
}

// Types pour les statistiques stablecoins (USDC, USDT0, USDE, USDH)
export interface StablecoinsStats {
    // Montants on-chain
    totalSpotUSDC: number;
    totalSpotUSDT0: number;
    totalSpotUSDE: number;
    totalSpotUSDH: number;
    totalStablecoins: number;
    // Holders
    USDC_holdersCount: number;
    USDT0_holdersCount: number;
    USDE_holdersCount: number;
    USDH_holdersCount: number;
    // HIP-2
    USDC_HIP2: number;
    USDT0_HIP2: number;
    USDE_HIP2: number;
    USDH_HIP2: number;
    // Variations 24h (montants absolus)
    totalSpotUSDC_change24h: number | null;
    totalSpotUSDT0_change24h: number | null;
    totalSpotUSDE_change24h: number | null;
    totalSpotUSDH_change24h: number | null;
    totalStablecoins_change24h: number | null;
    // Variations 24h (pourcentage)
    totalSpotUSDC_changePct24h: number | null;
    totalSpotUSDT0_changePct24h: number | null;
    totalSpotUSDE_changePct24h: number | null;
    totalSpotUSDH_changePct24h: number | null;
    totalStablecoins_changePct24h: number | null;
    // Variations 24h holders
    USDC_holdersCount_change24h: number | null;
    USDT0_holdersCount_change24h: number | null;
    USDE_holdersCount_change24h: number | null;
    USDH_holdersCount_change24h: number | null;
}

export interface PerpGlobalStats {
    totalOpenInterest: number;
    totalVolume24h: number;
    totalPairs: number;
    hlpTvl: number; // TVL du vault HLP
}

export interface GlobalStats {
    spot: SpotGlobalStats;
    perp: PerpGlobalStats;
    bridgedUsdc: {
        totalCirculating: number;
    };
    nUsers: number;
    dailyVolume: number;
    vaultsTvl: number;
}

export interface GlobalStatsResponse extends BaseResponse {
    data: GlobalStats;
}

export interface DashboardGlobalStats {
    spot?: {
        totalVolume24h: number;
        totalPairs: number;
        totalMarketCap: number;
        totalSpotUSDC: number;
        totalHIP2: number;
    };
    perp?: {
        totalOpenInterest: number;
        totalVolume24h: number;
        totalPairs: number;
    };
    /** Null when DefiLlama failed and no copy of its last answer is left. */
    bridgedUsdc: number | null;
    /**
     * The fields below are null while their source has nothing to give (a
     * cold Redis before the pollers' first write, a source failing for more
     * than 10 min).
     */
    numberOfUsers: number | null;
    dailyVolume: number | null;
    totalHypeStake: number | null;
    vaultsTvl: number | null;
}

// Types pour les informations des tokens
// Types pour le tri et la pagination
export interface SortIndices {
    volume: number[];
    marketCap: number[];
    change24h: number[];
}

export interface PerpSortIndices {
    volume: number[];
    openInterest: number[];
    change24h: number[];
}

export interface WebSocketMarketData {
    spot: {
        all: MarketData[];
        sortIndices: SortIndices;
    };
    perp: {
        all: PerpMarketData[];
        sortIndices: PerpSortIndices;
    };
    error?: string;
}

export interface MarketQueryParams {
    sortBy?: 'volume' | 'marketCap' | 'change24h' | 'name' | 'price';
    sortOrder?: 'asc' | 'desc';
    limit?: number;
    page?: number;
    token?: string;
    pair?: string;
}

// PaginatedResponse est maintenant importé de common.types.ts

export interface PerpMarketQueryParams {
    sortBy?: 'volume' | 'openInterest' | 'change24h' | 'name' | 'price';
    sortOrder?: 'asc' | 'desc';
    limit?: number;
    page?: number;
    token?: string;
    pair?: string;
}