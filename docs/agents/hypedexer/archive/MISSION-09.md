# MISSION-09 — Spot indexer (4 endpoints)

## Endpoints

1. `GET /spot/auctions/hist`
2. `GET /spot/auctions/live`
3. `GET /spot/pairs`
4. `GET /spot/tokens`

## Livrables

- `src/clients/hypedexer/rest/spot/spot-indexer.client.ts`
- `src/routes/indexer/spot.routes.ts` — mount `/indexer/spot/...`
