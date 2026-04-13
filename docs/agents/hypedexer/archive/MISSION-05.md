# MISSION-05 — HIP-3 core (5 endpoints)

## Endpoints

1. `GET /hip3/assets`
2. `GET /hip3/assets/{ticker}`
3. `GET /hip3/dexs`
4. `GET /hip3/dexs/{dex_id}`
5. `GET /hip3/overview`

## Livrables

- `src/clients/hypedexer/rest/hip3/hip3.client.ts` (découper en sous-fichiers si croissance)
- Préfixe route `/indexer/hip3/...`
- Canal Redis futur : `HYPEDEXER_CHANNELS.hip3` (si polling un jour)
