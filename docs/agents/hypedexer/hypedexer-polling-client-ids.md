# HypeDexer — clients polling REST : IDs circuit breaker / rate limiter

> Les classes `HLIndexer*` résident sous `src/clients/hypedexer/rest/`. **Ne pas renommer** les IDs ci-dessous (circuit breaker / rate limiter) sans migration coordonnée.

| Client | Fichier | Circuit breaker | Rate limiter |
|--------|---------|-----------------|--------------|
| HLIndexerLiquidationsClient | `rest/liquidations/liquidations.client.ts` | `liquidations` | `liquidations` |
| HLIndexerTopTradersClient | `rest/toptraders/toptraders.client.ts` | `toptraders` | `toptraders` |
| HLIndexerActiveUsersClient | `rest/activeusers/activeusers.client.ts` | `activeusers` | `activeusers` |
| HLIndexerBuildersClient | `rest/builders/builders-list-poller.client.ts` | `builders` | `builders` |
