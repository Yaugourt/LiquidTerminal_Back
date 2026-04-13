# MISSION-12 — Vaults (6 endpoints)

## Endpoints

1. `GET /vaults/dailySnapshots`
2. `GET /vaults/equitySnapshots`
3. `GET /vaults/userVaultEquities`
4. `GET /vaults/vaultDetails`
5. `GET /vaults/vaultLedger`
6. `GET /vaults/vaultSummaries`

## Livrables

- Un client `vaults-indexer.client.ts` avec 6 méthodes (scinder si > ~300 lignes)
- Routes `/indexer/vaults/...` — noms kebab-case pour l’API publique

## Notes

- Vérifier chevauchement sémantique avec routes vault Hyperliquid existantes (`/market/vaults`)
