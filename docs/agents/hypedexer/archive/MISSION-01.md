# MISSION-01 — Analytics fills + Builders (5 endpoints)

## Endpoints upstream (GET)

1. `/analytics/fills/stats`
2. `/builders/list` — poller `HLIndexerBuildersClient` dans `rest/builders/builders-list-poller.client.ts` (déjà sur `/builders/list`) ; pass-through détail dans `builders-indexer.client.ts`
3. `/builders/stats`
4. `/builders/stats/all-timeframes`
5. `/builders/top`

## Livrables

- `src/clients/hypedexer/rest/builders/` ou extension client builders dédié
- Schémas Zod query si l’OpenAPI en définit
- Routes : sous `/indexer/builders/...` **ou** extension des routes `/builders` existantes (documenter le choix dans `CLIENT_ARCHITECTURE.md`)
- Pas de polling global sans lock ; TTL documentés dans `hypedexer.cache.ts` si cache

## Critères done

- `npm run build` ; `npm run hypedexer:inventory` montre ces paths **Implemented** ou **Partial** résolu
