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
    supply: number;
    marketIndex: number;
    tokenId: string;
}

export interface SpotUSDCData {
    date: number;
    lastUpdate: number;
    totalSpotUSDC: number;
    totalCirculating: {
        peggedUSD: number;
    };
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

// Types pour les statistiques globales
export interface SpotGlobalStats {
    totalVolume24h: number;
    totalPairs: number;
    totalMarketCap: number;
    totalSpotUSDC: number;
    totalHIP2: number;
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
    bridgedUsdc: number;
    numberOfUsers: number;
    dailyVolume: number;
    totalHypeStake: number;
    vaultsTvl: number;
}

// Types pour les informations des tokens
export interface TokenHolder {
    address: string;
    balance: string;
}

export interface ExistingTokenBalance {
    token: string;
    balance: string;
    decimals: number;
}

export interface TokenInfoResponse {
    name: string;
    maxSupply: string;
    totalSupply: string;
    circulatingSupply: string;
    szDecimals: number;
    weiDecimals: number;
    midPx: string;
    markPx: string;
    prevDayPx: string;
    deployer: string;
    deployGas: string;
    deployTime: string;
    seededUsdc: string;
    genesis: {
        userBalances: [string, string][];
        existingTokenBalances: ExistingTokenBalance[];
    };
    nonCirculatingUserBalances: [string, string][];
}

export interface FormattedTokenInfo extends Omit<TokenInfoResponse, 'genesis' | 'nonCirculatingUserBalances'> {
    holders: TokenHolder[];
    nonCirculatingHolders: TokenHolder[];
}

export interface TokenInfoResponseWrapper extends BaseResponse {
    data: TokenInfoResponse;
}

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