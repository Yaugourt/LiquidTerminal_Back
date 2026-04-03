# MISSION-13 — Overview restant + inventaire final

## Contexte

Les endpoints overview suivants sont **déjà** exposés via `HypeDexerOverviewIndexerClient` et `/indexer/overview/*` :

- `active-traders-24h`, `coin-distribution`, `daily-pnl-10d`, `daily-volume-10d`, `total-fees-24h`, `total-fills-24h`, `trading-volume-24h`

## Tâches

1. Vérifier qu’aucun paramètre query manquant (ex. `daily-volume-10d` si le spec ajoute des filtres)
2. Après toutes les missions : exécuter `npm run hypedexer:inventory` et viser **Missing = 0** (hors `GET /ws` ; top-traders 24h couvert par le client polling `rest/toptraders/`)
3. Mettre à jour `CLIENT_ARCHITECTURE.md` tableau des routes `/indexer`

## Endpoint WebSocket

- `GET /ws` dans OpenAPI : **ne pas** implémenter en REST ; utiliser `clients/hypedexer/websocket/`
