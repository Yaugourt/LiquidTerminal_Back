# MISSION-11 — Users profile (3 endpoints)

## Endpoints

1. `GET /users/{user}/coins`
2. `GET /users/{user}/overview`
3. `GET /users/{user}/performance`

## Livrables

- Étendre `HypeDexerUsersIndexerClient` ou `users-profile.client.ts`
- Routes sous `/indexer/users/:user/...` (ne pas confondre avec `/user` auth)
