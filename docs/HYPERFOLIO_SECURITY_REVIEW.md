# Revue sécurité & rate limiting — proxy Hyperfolio (backend)

**Date :** 2026-09-23 · **Branche :** `feat/hyperfolio` (base `c4220b9`) · **Pendant front :** `liquidterminal_front/docs/HYPERFOLIO_SECURITY_REVIEW.md`

**Périmètre :** `src/clients/hyperfolio/*`, `src/services/hyperfolio/hyperfolio.service.ts`,
`src/routes/hyperfolio/hyperfolio.routes.ts`, `src/schemas/hyperfolio.schema.ts`,
`src/errors/hyperfolio.errors.ts`, `src/constants/hyperfolio.cache.ts`, plus l'infra partagée
qu'ils utilisent (`BaseApiService`, `CircuitBreakerService`, `cacheService.getOrSet`, `marketRateLimiter`).

**Contrainte upstream (vérifiée le 2026-09-16) :** Hyperfolio applique une limite de burst
d'environ 20 req/s **par clé API**. Au-delà, il répond `403 "Per-second request limit exceeded"`
(et non 429), sans `Retry-After`. La clé est partagée par tous les visiteurs de LiquidTerminal :
un seul client abusif peut donc faire throttler tout le monde.

---

## 1. Ce qui était déjà conforme

| Point | Constat |
|---|---|
| Secret | `HYPERFOLIO_API_KEY` est lue depuis l'env et n'est envoyée qu'en header `x-api-key` sortant. Elle n'apparaît dans aucun log (`fetchWithTimeout` logge l'URL masquée, la méthode et le timeout, jamais les headers), aucune réponse, ni l'historique git (vérifié sur les deux repos, le working tree, `dist/` et `logs/`). `.env` est ignoré par git ; `.env.example` ne contient qu'un placeholder. |
| Clé absente | Pas d'échec au boot : les routes répondent `503 HYPERFOLIO_NOT_CONFIGURED`. |
| Clé rejetée | Un 401/403 upstream (hors burst) devient `502 HYPERFOLIO_UNAUTHORIZED`, sans divulguer la clé. |
| Validation d'entrée | Zod sur chaque route : adresse `0x` stricte ou nom `.hype`/`.hl` (regex bornée, 128 car. max), `days` 1–365, pagination bornée (`offset`/`limit` ≤ 100, `page_size` ≤ 200), chaînes ≤ 120, tableaux ≤ 20 éléments, enums fermés. Les paramètres inconnus sont retirés avant l'appel upstream (re-parse dans la route). |
| Injection de query | `URLSearchParams` encode tout ; les tableaux passent en paramètres répétés, comme l'API l'exige. |
| Pas de SSRF | L'hôte upstream est fixé par l'env. Aucune URL fournie par l'utilisateur n'est jamais appelée. |
| Cache | Redis, TTL de 60 à 600 s par endpoint, verrou anti-stampede de `getOrSet`, single-flight en mémoire dans le client. |
| Throttle upstream | Le 403 burst et le 429 sont mappés sur `429 HYPERFOLIO_RATE_LIMITED` + `Retry-After: 10`, avec un cooldown partagé de 10 s. |
| SSE | Pas de clé côté navigateur (proxy). Plafonds de 3 flux par IP et 200 au total, heartbeat 15 s, timeout upstream 90 s, gestion du backpressure (`drain`), nettoyage sur `close`/`error`. Vérifié sur Node 22 : `req.on('close')` ne se déclenche qu'à la déconnexion réelle du client. |
| Rate limit HTTP | `marketRateLimiter` (Redis ; 60 req/s, 1 200/min, 72 000/h par IP ; repli en mémoire fail-secure) sur toutes les routes JSON. `trust proxy = 1`. |

---

## 2. Problèmes trouvés et corrigés

### H1 — Un anonyme pouvait couper Hyperfolio pour tout le monde via le circuit breaker (élevé)
`getPath` levait `HyperfolioBadInputError` **à l'intérieur** de `circuitBreaker.execute`. Les
400, les 403 burst et les 429 y étaient aussi comptés comme des pannes. Or Hyperfolio répond
`200 + {error}` à un nom `.hype` introuvable. Cinq requêtes `GET /hyperfolio/wallet/<nom-bidon>.hype/points`
ouvraient donc le breaker pendant 30 s, et toutes les routes Hyperfolio répondaient 502 pour
tous les utilisateurs. C'est répétable à volonté, et ça tient sous le rate limit par IP.

**Correctif :** les échecs causés par l'appelant ou par le quota (entrée invalide, 400, 403 burst,
429, throttle local) sortent du breaker comme des valeurs, pas comme des exceptions. Le breaker
ne compte plus que la vraie santé de l'upstream (5xx, timeouts, erreurs réseau).
**Vérifié en live :** 6 noms `.hype` bidons consécutifs donnent 6 × `400 HYPERFOLIO_BAD_INPUT`,
puis l'appel valide suivant répond normalement (19 tokens).

### H2 — Pas de plafond global vers Hyperfolio : un seul client pouvait épuiser la clé partagée (élevé)
Le seul frein était `marketRateLimiter`, soit 60 req/s par IP. Chaque variation de `search`,
`page`, `min_tvl` ou d'adresse crée une nouvelle clé de cache. Une seule IP pouvait donc
envoyer environ 60 appels/s à Hyperfolio, soit 3 fois sa limite. Résultat : 403 en boucle, puis
le cooldown de 10 s se relançait sans fin, ce qui revient à un déni de service sur toutes les
fonctions Hyperfolio. Le `RateLimiterService('hyperfolio')` du client était bien instancié, mais
`checkRateLimit()` n'était **jamais appelé**.

**Correctif, à deux niveaux :**
- **Budget global par process :** fenêtre glissante de 8 appels/s vers Hyperfolio, partagée
  par les routes JSON et le flux SSE. Un appel attend au plus 2 s qu'un créneau se libère, sinon
  il reçoit `429`. Ce throttle local n'ouvre **pas** le cooldown partagé.
- **Budget par IP, compté uniquement sur les cache-miss :** `checkRateLimit(ip)` est maintenant
  branché (30 appels upstream/min par IP). Les réponses servies depuis le cache ne consomment rien.

Nouvelle erreur `HyperfolioThrottledError` (429, même code `HYPERFOLIO_RATE_LIMITED`, donc
aucun changement côté front) : ni le throttle local ni un client abusif ne bloquent les autres.

### M1 — Amplification : `get()` rejouait les 429 et les timeouts (moyen)
Les endpoints sans timeout explicite (composition, history, nfts, points, yield) passaient par
`BaseApiService.get`, donc par `withRetry` : 3 tentatives sur 429/502–504 **et** sur les timeouts,
avec un backoff multiplié par 3 sur 429. Face à un upstream qui throttle, on renvoyait donc
plus de requêtes. Face à un upstream lent, une requête pouvait rester bloquée environ 90 s.

**Correctif :** une seule tentative partout (`getSingleAttempt`, timeout par défaut 30 s),
plus un unique retry après 1,1 s réservé au 403 burst. Ce retry repasse lui aussi par le budget global.

### M2 — Double appel upstream à chaque échec (moyen)
En cas d'erreur, `cacheService.getOrSet` rappelle `fetchFn` une seconde fois (sa branche
« fall back to direct fetch »). Chaque échec coûtait donc 2 appels upstream. Un timeout de
transactions (45 s) bloquait la requête 90 s. Seul le cas 429 était déjà couvert, par le cooldown.

**Correctif :** dans `HyperfolioService.cached`, le premier échec est mémorisé et rejoué, sans
nouvel appel. `getOrSet` reste utilisé pour son verrou anti-stampede.

### M3 — Le flux SSE n'avait pas de limite de débit (moyen)
La route `/positions/stream` n'avait qu'un plafond de **concurrence** (3 flux par IP). Une boucle
ouvrir/abandonner relançait donc à chaque fois un scan upstream complet de plus de 30 protocoles.
Le cache n'étant rempli qu'à la fin d'un flux complet, il ne protégeait pas ce cas.

**Correctif :** `marketRateLimiter` sur la route (il compte l'ouverture, pas la durée). Une
ouverture qui va jusqu'à l'upstream consomme le budget par IP, puis un créneau du budget global.
Les rejeux depuis le cache restent gratuits.

### L1 — Le cache négatif manquait pour les entrées invalides (faible, mais coûteux)
Chaque résolution d'un nom `.hype` introuvable coûte **6 à 7 s** côté Hyperfolio (mesuré en live).
**Correctif :** un marqueur `BAD_INPUT` est mis en cache à la place du payload, avec le TTL de
l'endpoint. Une répétition reçoit directement un 400 depuis Redis. `peekPositions` ignore ce
marqueur, pour ne pas le rejouer comme s'il s'agissait de positions.

### L2 — Détails internes renvoyés au client (faible)
`HyperfolioUpstreamError(error.message)` renvoyait le message de transport tel quel au navigateur
(`API request failed: getaddrinfo…`, `Circuit breaker is open`), et `HyperfolioBadInputError`
recopiait le texte d'erreur de l'upstream.
**Correctif :** messages génériques côté client. Le détail est journalisé (`warn` pour le
transport, `info` pour l'entrée rejetée par l'upstream).

### L3 — Timeout du flux indiscernable d'une déconnexion (faible)
Quand le timeout upstream de 90 s déclenchait l'abort, le proxy ne l'envoyait pas au client :
il le traitait comme une déconnexion. Le flux se terminait sans `complete` et le front ne
découvrait l'échec que par `onerror`.
**Correctif :** un drapeau `timedOut` provoque l'envoi d'un événement `{type:'error', fatal:true}`
avant la fermeture. Le front bascule alors immédiatement sur la route JSON.

### L4 — Option de circuit breaker ignorée (cosmétique)
Le client passait `resetTimeout`, mais `CircuitBreakerService` lit `circuitBreakerTimeout`. La
valeur était ignorée (sans effet, car elle vaut aussi 30 s par défaut). Le nom est corrigé.

---

## 3. Budgets en vigueur après correctif

| Niveau | Limite | Où |
|---|---|---|
| HTTP par IP (toutes les routes `/hyperfolio/*`, SSE compris) | 60/s · 1 200/min · 72 000/h | `marketRateLimiter` |
| Appels upstream par IP (cache-miss uniquement) | 30/min | `HyperfolioClient.checkRateLimit` (appelé dans `HyperfolioService.cached` et avant l'ouverture SSE) |
| Appels upstream, tout le process | 8/s, attente ≤ 2 s puis 429 | `UpstreamThrottle` dans `hyperfolio.client.ts` |
| Flux SSE simultanés | 3 par IP · 200 au total | `HYPERFOLIO_STREAM` |
| Cooldown après un throttle upstream réel (403 burst / 429) | 10 s, partagé | `HyperfolioService.rateLimitedUntil` |
| Circuit breaker | 5 pannes upstream consécutives, puis 30 s ouvert | `CircuitBreakerService('hyperfolio')` |
| Timeouts | 30 s par défaut · 45 s transactions · 60 s positions · 90 s flux | client / constants |

Une page wallet à froid coûte environ 6 appels upstream : composition, flux positions, history,
points, nfts et transactions. On reste donc nettement sous les 30/min par IP, même avec un
« refresh all ».

---

## 4. Points résiduels (non corrigés, à arbitrer)

1. **Budgets en mémoire, par process.** Avec N instances du back (PM2 cluster, réplicas),
   le plafond global devient N × 8/s et le budget par IP devient N × 30/min. Si on passe en
   multi-instance, déplacer les deux compteurs dans Redis (même modèle que `marketRateLimiter`).
2. **Stampede sur le flux SSE.** N visiteurs qui ouvrent le même wallet à froid ouvrent N flux
   upstream (pas de single-flight sur le SSE, contrairement au JSON). C'est borné par les budgets
   ci-dessus, mais on pourrait partager un flux upstream par wallet (fan-out côté proxy).
3. **Le flux SSE contourne le sémaphore sortant global** (`acquireOutboundSlot`, 50 sockets).
   Il est plafonné à 200 flux, et un flux de longue durée qui prendrait un des 50 créneaux
   bloquerait les pollers. Choix assumé.
4. **Ouverture du breaker = 502.** Le front l'affiche comme une erreur générique. Un code
   `503 HYPERFOLIO_UNAVAILABLE` serait plus clair, mais le front mappe aujourd'hui 503 sur
   « not configured ». Il faudrait changer les deux côtés ensemble.

---

## 5. Vérifications

- `npx tsc --noEmit` : OK · `eslint` sur les fichiers touchés : OK
- `npx jest` : **13 suites, 149 tests OK**, dont le nouveau `tests/unit/services/hyperfolio.guards.test.ts` (9 tests) :
  - le breaker ne s'ouvre pas après 6 entrées invalides ;
  - un 429 n'est pas rejoué ; un 500 n'est pas rejoué et son message n'est pas renvoyé au client ;
  - le 403 burst est rejoué exactement une fois ;
  - 12 appels simultanés : 8 partent immédiatement, les 4 autres dans la seconde suivante ;
  - un échec au cache-miss ne produit qu'un seul appel upstream ;
  - une entrée invalide est mise en cache (marqueur) et renvoie un 400 ;
  - le budget par IP épuisé donne un 429 sans cooldown global ; les autres IP passent ;
  - un vrai throttle upstream ouvre bien le cooldown partagé.
- `tests/integration/routes/hyperfolio.validation.smoke.test.ts` : mis à jour (les services reçoivent l'IP).
- Test live contre `api.hyperfolio.xyz` avec le client modifié : cf. H1 ; `/yield` avec
  paramètres répétés : OK (595 opportunités).

**Déploiement :** l'instance lancée sur :3002 tourne encore sur l'ancien build. Il faut `npm run build`
puis la redémarrer pour appliquer ces correctifs.

---

## 6. Mise à jour 2026-10-13 — trafic à l'échelle

Les garde-fous ci-dessus restent ; leurs valeurs changent pour des milliers de visiteurs, dont
beaucoup derrière une même IP (CGNAT mobile, bureaux) :

- **Budget par IP des cache-miss :** 30 → 120 appels upstream/min. Les plafonds qui protègent la
  clé restent le global de 8 appels/s par process et le budget journalier (`HYPERFOLIO_DAILY_BUDGET`,
  50 000 par défaut : une estimation, le quota payant réel est inconnu).
- **Copie de secours :** chaque clé garde une dernière copie (environ 10 TTL, au plus 10 min :
  les clés sont par wallet, une copie plus longue gonflerait Redis). Un cache-miss
  refusé par un garde-fou (budget IP, cooldown, budget global ou journalier) ou une panne upstream
  sert cette copie avec `stale: true` au lieu d'une erreur. Un wallet jamais lu, ou pas lu depuis plus
  longtemps que sa copie n'est gardée, reçoit l'erreur.
- **SSE :** 30 flux par IP et 500 au total (`HYPERFOLIO_STREAMS_PER_IP`, `HYPERFOLIO_STREAMS_TOTAL`).
  Au-delà, `503 SSE_CONNECTION_LIMIT` + `Retry-After: 3` (plus un 429 terminal).
- **Rate limit HTTP :** `marketRateLimiter` passe à 200 req/s, 6 000/min, 300 000/h par IP
  (`RATE_LIMIT_*`), `Retry-After` = secondes avant la fin de la fenêtre qui a refusé (exposé par CORS).

