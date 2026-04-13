# MISSION-03 — Fills per-user & spot fills (3 endpoints)

## Endpoints

1. `GET /fills/user/{user_address}`
2. `GET /fills/spot/`
3. `GET /fills/spot/user/{user_address}`

## Livrables

- Étendre `HypeDexerFillsClient` ou `fills/spot.client.ts` si fichier > ~300 lignes
- Schémas : `user_address` en param path (ethereum-like)
- Routes `/indexer/fills/user/:userAddress`, `/indexer/fills/spot/...`

## Notes

- Données potentiellement lourdes : **pas** de polling ; cache optionnel TTL court
