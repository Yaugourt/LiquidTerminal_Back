# MISSION-10 — TWAPs (5 endpoints)

## Endpoints

1. `GET /twaps/`
2. `GET /twaps/stats`
3. `GET /twaps/user/{user_address}`
4. `GET /twaps/{twap_id}`
5. `GET /twaps/{twap_id}/fills`

## Livrables

- Client + service + routes `/indexer/twap/...` (ou `/indexer/twaps/...` aligné OpenAPI)
- Params : `twap_id`, `user_address`
