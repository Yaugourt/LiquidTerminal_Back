# HypeDexer (HL Indexer) — missions pour sous-agents

**Plan de suite & orchestration sous-agents :** [PLAN_SUITE_SOUS_AGENTS.md](./PLAN_SUITE_SOUS_AGENTS.md) (ordre des vagues, parallélisation, prompt type, rôle « chef »).

Les playbooks **MISSION-01 … MISSION-13** sont **archivés** dans [`archive/`](./archive/) (référence historique ; la couverture actuelle est dans l’inventaire ci-dessous).

**IDs polling (CB / rate limiter) :** [hypedexer-polling-client-ids.md](./hypedexer-polling-client-ids.md)

**Références**

- Spec : `docs/hypedexer_endpoints.json` (sync : `curl -sS https://api-eu.hypedexer.com/openapi.json -o docs/hypedexer_endpoints.json`)
- Inventaire : `npm run hypedexer:inventory` → `docs/hypedexer_endpoints.inventory.md`
- Architecture : `docs/CLIENT_ARCHITECTURE.md` section 11
- Redis : `src/constants/hypedexer.cache.ts`
- Stack exemple : `src/clients/hypedexer/rest/`, `src/routes/indexer/`

**Checklist par endpoint**

1. Types + Zod (query/path)
2. Méthode client (`BaseApiService` + circuit breaker + rate limiter par domaine)
3. Service (cache seulement si justifié ; pas de polling sur historique lourd)
4. Route sous `/indexer/...` ou préfixe produit validé
5. `npm run build` + tests ciblés si logique non triviale
