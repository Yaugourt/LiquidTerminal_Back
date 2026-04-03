# MISSION-04 — Funding (3 endpoints)

## Endpoints

1. `GET /funding/fundingHistory`
2. `GET /funding/predictedFundings`
3. `GET /funding/userFunding`

## Livrables

- `src/clients/hypedexer/rest/funding/funding.client.ts`
- `src/services/indexer/indexer-funding.service.ts`
- `src/routes/indexer/funding.routes.ts` + mount dans `routes/indexer/index.ts`

## Notes

- Vérifier query params dans l’OpenAPI pour chaque route
