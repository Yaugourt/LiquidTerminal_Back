# MISSION-02 — Builders détail + Completed trades (5 endpoints)

## Endpoints

1. `GET /builders/{builder_address}/stats`
2. `GET /builders/{builder_address}/users`
3. `GET /completed-trades/`
4. `GET /completed-trades/summary`
5. `GET /completed-trades/{trade_id}/fills`

## Livrables

- Client `completed-trades.client.ts` sous `hypedexer/rest/completed-trades/`
- Param path validés (Zod `params`)
- Routes `/indexer/completed-trades/...`

## Notes

- `trade_id` : type string dans l’URL ; valider format si le spec le précise
