# API Liquidations Data (Endpoint Unifié)

## Endpoint

### `GET /api/v1/liquidations/data`

Retourne **stats ET chart** pour toutes les périodes en **un seul appel**.

## Response Format

```typescript
interface LiquidationsDataResponse {
    success: boolean;
    periods: {
        "2h": PeriodData;
        "4h": PeriodData;
        "8h": PeriodData;
        "12h": PeriodData;
        "24h": PeriodData;
    };
    metadata: {
        executionTimeMs: number;
        cachedAt: string;
    };
}

interface PeriodData {
    stats: {
        totalVolume: number;
        liquidationsCount: number;
        longCount: number;
        shortCount: number;
        topCoin: string;
        topCoinVolume: number;
        avgSize: number;
        maxLiq: number;
        longVolume: number;
        shortVolume: number;
    };
    chart: {
        interval: "5m" | "15m" | "30m";
        buckets: ChartBucket[];
    };
}

interface ChartBucket {
    timestamp: string;
    timestampMs: number;
    totalVolume: number;
    longVolume: number;
    shortVolume: number;
    liquidationsCount: number;
    longCount: number;
    shortCount: number;
}
```

## Intervalles Chart

| Période | Intervalle | Buckets |
| ------- | ---------- | ------- |
| 2h      | 5min       | 24      |
| 4h      | 5min       | 48      |
| 8h      | 15min      | 32      |
| 12h     | 15min      | 48      |
| 24h     | 30min      | 48      |

## Cache

**TTL : 60 secondes**

## Migration Frontend

```typescript
// ❌ Avant : 2 endpoints
const stats = await fetch("/api/v1/liquidations/stats/all");
const chart = await fetch("/api/v1/liquidations/chart-data?period=24h");

// ✅ Après : 1 endpoint, tout en mémoire
const { periods } = await fetch("/api/v1/liquidations/data");
// periods['24h'].stats pour les stats
// periods['24h'].chart.buckets pour le chart
```

## Gains

| Métrique                      | Avant | Après |
| ----------------------------- | ----- | ----- |
| Appels au chargement          | 3     | 1     |
| Appels par changement période | 1     | 0     |
