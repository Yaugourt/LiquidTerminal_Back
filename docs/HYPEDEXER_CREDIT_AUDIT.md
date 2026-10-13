# HypeDexer credit audit and fix plan

> Audit date: 2026-09-25, on back `perf/step-3` @ `091321f` and front `perf/step-1` @ `9092fd8`.
> Every number below was **measured**, not estimated from code: a counting proxy sat between the backend and HypeDexer and logged each call's `X-Credit-Cost`, and Playwright visited the pages one by one.
> The same file lives in both repos (`LiquidTerminal_Back/docs/` and `liquidterminal_front/docs/`). When you tick a fix, update both.

## 1. How HypeDexer bills us (measured on our key)

| Item | Rule | Note |
|---|---|---|
| REST call | **`2 + ceil(rows / 10)` credits** | Fits 337 of 344 calls. An object payload counts as 1 row (3 credits); an empty list costs 2. The public docs say `ceil(rows/25)`, which understates big pages by about 2.5×. |
| Errors (status ≥ 400) | free | |
| WebSocket | **not debited today** | A/B test on `X-Credit-Balance`: adding one `allFills` socket (~2.4–3.7k msgs/min) moved the burn by +4 cr/min, where 10 events/credit would have given +173. The docs say 10 events = 1 credit, so this may change. |
| Balance | `X-Credit-Balance` is returned on every response | Local key ≈ 999 690 M, i.e. ≈ 309 M consumed if the allocation was 1e12. Only local backends use this key; **prod has its own key**, and its balance must be read on the prod side. |

The user's plan is "unlimited but don't abuse it". Public plans for scale: Starter 500k/month, Growth 3M, Scale 12.5M.

**Consequence:** cost is driven by **rows returned × how often**. Asking for 5 000 rows costs 502 credits, even when the UI shows one number.

## 2. Unit costs measured

| Upstream call | Rows | Credits |
|---|---|---|
| scalar: `/overview/*-24h`, `/hip3/overview`, `/builders/stats*`, analytics stats | 1 | 3 |
| `/overview/top-traders-24h?limit=50`, `/hip4/settlements?limit=50`, `/hip4/fills?limit=50` | 50 | 7 |
| `/liquidations/recent?limit=100`, `/users/active?limit=100`, `/users/leaderboard?limit=100`, `/hip4/{markets,outcome-tokens,questions}` (no limit) | 100 | 12 |
| `/twaps?limit=150` | 150 | 17 |
| `/hip4/fills?coin=#N&limit=400` | 400 | 42 |
| `/vaults/equitySnapshots?limit=500`, `/hip4/markets?limit=500` | 500 | 52 |
| `/liquidations/recent?limit=1000`, `/liquidations/?limit=1000` (backfill), `/hip4/fills?coin&limit=1000` | 1000 | 102 |
| `/builders/list` (`limit=1000` is ignored upstream) | 1424 | 145 |
| `/overview/daily-pnl-10d` | 3240 | 326 |
| `/vaults/vaultSummaries?includeClosed=true&limit=5000`, `/funding/userFunding?user&limit=5000` | 5000 | 502 |
| `/vaults/vaultLedger` (always empty, see §6) | 0 | 2 |

## 3. Background consumption, 0 visitors (measured over 51 min)

| Poller (file) | Period | Credits/call | Calls/day | Credits/day |
|---|---|---|---|---|
| `/liquidations/recent?limit=100` (`clients/hypedexer/rest/liquidations/liquidations.client.ts`, registered in `core/client.initializer.service.ts` despite the "polling disabled" comments) | 15 s | 12 | 5 760 | 68k |
| `/builders/list?limit=1000` (`builders/builders-list-poller.client.ts`) | 5 min | 145 | 288 | 41k |
| `/users/active` ×4 hours (`activeusers/activeusers.client.ts`) | 2 min | 12 | 2 880 | 34k |
| `/overview/top-traders-24h` ×4 sorts (`toptraders/toptraders.client.ts`) | 2 min | 7 | 2 880 | 20k |
| metrics snapshot: active-traders + total-fees (`clients/metrics/metrics-snapshot.client.ts`) | 5 min | 3 | 576 | 1.7k |
| liquidations backfill (`services/liquidations/liquidations.backfill.service.ts`) | boot + 03:00 UTC | 102 | 1–2 | 0.2k |
| **Total** | | | ~12.4k | **~165k/day (~5M/month)** |
| completed-trades feed (`completed-trades/completed-trades-poller.client.ts`), only while ≥1 wallet is watched | 5 s | 7–11 (~15 s of trades at 3–6 trades/s) | 17 280 | +121–190k/day |

WebSockets are free today but heavy:
- `allFills`: 2.4–3.7k msgs/min, 1.6–2.1 MB/min. It stays connected even when no fill alert subscription exists (`services/telegram/telegram.fill-alert-dispatcher.service.ts`).
- `liquidations`: about 1 msg/min.
- `l4Book`, per watched coin: ~245 msgs/min, plus a ~0.7 MB snapshot every ~16 s because of the resync.

## 4. Cost per page (one visible tab; hidden tabs pause polling)

"Per visitor" means each open tab adds the cost, because the backend route is uncached or keyed per user. "Shared" means the backend cache serves everyone, so the cost doesn't grow with the audience.

| Page | First load | Credits/min while open | Per day if open 24 h | Scaling | Main culprit |
|---|---|---|---|---|---|
| `/market/hip4/[non-live question]` (29 outcomes) | 830 | **~1300** | 1.9M | per visitor | `useHip4ProbabilityHistory`: N × `/hip4/fills?coin=#N&limit=1000` every 30 s, uncached |
| `/explorer/vaults/[vault with sub-vaults, e.g. HLP]` | 570 | ~570 | 820k | per visitor | `vaultSummaries?limit=5000` every 60 s (`VaultSubVaults`), equitySnapshots 500 rows |
| `/explorer/vaults` | 770 | ~560 | 800k | per visitor (502) + shared (54) | `vaultSummaries?includeClosed=true&limit=5000` every 60 s, uncached |
| `/explorer/address/[wallet]` and `/market/tracker/wallet/[wallet]` (active wallet) | 530 | ~520 | 750k | per visitor | `/indexer/funding/userFunding/summary`, which fetches `limit=5000` (30 s cache) every 60 s |
| `/dashboard/market` | 480 | ~300 | 430k | shared, capped at ~480/min | `/liquidations/recent?limit=1000&hours=24` (102 cr) every 30 s; `daily-pnl-10d` (326 cr) every 5 min |
| `/market/hip4` | 410 | ~250 | 360k | ~170 per visitor + 80 shared | settlements (4 uncached calls every 30 s), `fills?limit=50` every 15 s, volume fan-out (~270 cr per 5 min per visitor) |
| `/market/hip4/[live coin]` | 310 | ~230 | 330k | per visitor | `fills?coin&limit=400` every 15 s, volume fan-out |
| `/market/builders`, `/market/builders/intelligence` | 150 | ~160 | 230k | per visitor (145) | `/indexer/builders/list` uncached every 60 s |
| `/market/perpdex/[dex]/[asset]` | 30 | ~60 | 86k | per visitor | `hip3/fills` every 10 s, snapshots, traders, all uncached |
| `/market` | 75 | ~50 | 70k | mixed | twaps 150 rows, builders top `limit=3` (bypasses cache) |
| `/explorer/priority-fees` | 95 | ~35 | 50k | mostly shared | series = 25 calls per 5 min |
| `/explorer`, `/evm`, `/market/trades`, `/dashboard`, `/market/builders/[addr]` | 15–120 | 10–30 | 15–45k | mixed | |
| `/explorer/liquidations`, `/hype*`, `/market/tracker`, `/dashboard/capital` | ≤100 | ≤5 | ≤7k | — | |

### What 1 000 users would cost

Shared routes cost the same with 1 or 1 000 visitors. **Per-visitor routes scale linearly.**

- 1 000 visitors, each spending 10 visible minutes/day on per-visitor pages at ~300 cr/min, is **~3M credits/day (~90M/month)**. That is 18× the background.
- 100 people with `/explorer/vaults` open at the same time burn ~50k credits/min.
- A public route with an unbounded `limit` (§6) lets a single IP burn millions of credits per hour.

**Goal of the plan:** make the cost depend on the number of distinct data keys × refresh rate, never on the number of visitors.

## 5. Fix plan

Rules for every fix:
- Every HypeDexer call goes through a **shared backend cache** whose TTL is at least the front poll interval.
- The cache key contains every param that changes the upstream result.
- Ask for the rows you display, not 5 000.
- Anything we already store (liquidations) is read from our DB.

Work on shared infra carefully (see memory `careful-perf-changes`): one commit per step, and re-measure with the tools in §7.

### P0: stop per-visitor burn and guard public routes (backend, small changes)

Status 2026-09-28: every item below is done unless marked otherwise. Results in §8.

- [x] **P0.1 Bound every `limit`.** `.max()` on every list `limit` of the `/indexer/*` schemas: 1 000 by default (completed-trades, hip3, spot, twaps), 5 000 for vault summaries and snapshots (the front asks 5 000), 10 000 for the vault ledger (its "Load more" grows by 2 000; the front now stops at 10 000). Handlers still re-parse the raw query, but only after validation passed, so they never see an out-of-range value.
- [x] **P0.2 Rate limit uncached passthroughs.** `passthroughRateLimiter` is on the 60 `/indexer/*` routes whose cache key the caller controls (address, coin, limit, time range). Fixed-key cached routes (overview globals, builders stats/list, hip3 overview/auction, predicted fundings, vault leaderboards, fills count) keep only the general limiter. The burst went from 20/s to 60/s: a settled HIP-4 question with 29 outcomes fires ~45 indexer requests in its first second, `/market/hip4` 18. The 300/min cap, which is what bounds cost, is unchanged.
- [x] **P0.3 Vault summaries shared.** Summaries, details and equity snapshots 300 s, daily snapshots 30 min, keyed on every param, vault address lowercased (HypeDexer matches it case-insensitively, checked).
- [x] **P0.4 Dead `vaultLedger` calls.** Cached 1 h when empty (60 s otherwise), so it heals by itself if HypeDexer fixes the endpoint; the leaderboard fan-out reads the same cached entries (a recompute is now ~0 upstream calls). UI left as is.
- [x] **P0.5 Funding summary.** 30 min, key with `limit`, wallet lowercased; front polls every 5 min.
- [x] **P0.6 Builders list.** `/indexer/builders/list` returns the poller's `builders:all` (HypeDexer ignores every param of `/builders/list`: same 1 449 rows, checked). Poller TTL 20 min for a 15 min period (P2.3). The unused client method is gone.
- [x] **P0.7 HIP-4 probability history.** Front fetches once. Backend caches every user-less `/hip4/fills` read by the age of its newest fill: 15 s if the market traded in the last hour, 60 s if quiet, 1 h if dormant for a day (settled), 60 s when empty.
- [x] **P0.8 HIP-4 settlements.** 60 s shared; the three metadata lists come from a shared 10 min cache (P1.3, partial).

### P1: shrink shared costs and payloads

- [~] **P1.1 Liquidations from our DB.**
  - Done: `/dashboard/market` `LiquidationsPanel` reads only the local DB: its chart sums the 24h 30 min buckets of `/liquidations/data` (already fetched for the stats beside it, and no longer cut at 1 000 rows), its standouts come from the new `GET /liquidations/historical/top?period=24h&min_amount_dollars=100000&limit=3` (DB, deduplicated like the stats, 30 s cache).
  - Kept on HypeDexer: `/liquidations?user=`, because the DB only holds liquidations since its ingestion started (a wallet's older ones would vanish from the address digest). It is cached 5 min now (was uncached, polled every 60 s).
  - Not changed: `/explorer/liquidations`'s initial `limit=1000&hours=2`, once per visit, shared 15 s.
- [x] **P1.2 `daily-pnl-10d`.** 1 h.
- [x] **P1.3 HIP-4 base lists.** Shared 10 min cache for markets / outcome-tokens / questions, keyed on every param (60 s when upstream answers empty); `markets-enriched` and `questions-with-outcomes` keyed on `limit`/`offset` too. Truncation (option B, 2026-09-29): the lists stay the oldest markets, and what needs a recent one reads it by id instead of walking the list.
  - Deep links: `markets-enriched?outcome_id=X` answers one market. `#X` is side `X % 10` of outcome `floor(X / 10)`, whose row holds the market (the side coin's own row is a bare placeholder), so it reads that row: 3 credits, kept 24 h once settled, 5 min while open, shared by both sides. The detail page looks a coin up when it is not in the live list (and a question-bound market's question through `questions-with-outcomes?question_id=`) instead of redirecting to `/market/hip4`.
  - Settlements: each market missing from the metadata list is read the same way (≤ 50 per page, 4 at a time); the list page's 50 rows are ~17 markets.
  - Names: markets deployed from a Hyperliquid template (`template:binaryPrice`, `perp:HYPE|…|threshold:…|time:…`, sides `template:Yes` / `template:{shortNameA}`) are titled from Hyperliquid's free `outcomeTemplates` registry (back 1 h, front 1 h), price templates get class / underlying / strike / expiry, recurring price buckets their ranges; the live grid groups outcomeMeta's questions into one card each.
  - Cost: ~3 credits per market opened or settled, once (settled rows are kept a day).
- [x] **P1.4 HIP-4 volumes.** Done without a new endpoint: coin-filtered `/hip4/analytics` is cached 5 min, and the volume fan-out sends the same coin chunks for every visitor. Coin-filtered fills: P0.7. The unfiltered analytics key now includes `limit`.
- [x] **P1.5 Other short shared caches.** hip3 fills 15 s, snapshots 60 s, stats/traders 120 s; completed-trades list + summary 60 s; analytics stats 60 s; evm blocks with params 15 s; twaps list 60 s; builders/top for every limit (60 s, was 30 s and limit 25 only).
- [x] **P1.6 Front cache-friendly keys.** Biggest-trade `start_time` floored to the minute (was millisecond-unique); HubLanes asks `limit=200` like the other HIP-4 callers; the `BridgeTransfers` window moves with each poll (was frozen at mount). Top-traders callers already all ask ≤ 50 (served by the poller). Vault ledger limits left alone (cached 1 h while empty).

### P2: background pollers (fixed cost, ~165k/day)

- [x] **P2.1 Liquidations recent poller** removed; its key is filled on demand (the `/dashboard` seed, once per page load). Nothing subscribed to its update channel.
- [x] **P2.2 Pollers to 5 min.** `users/active` ×4 and `top-traders` ×4, TTL 330 s.
- [x] **P2.3 `builders/list` poller** every 15 min.
- [ ] **P2.4 Completed-trades feed.** Handled in a separate effort by the user.
- [ ] **P2.5 `allFills` socket.** Not done: WS is not billed today, and it touches the Telegram fill alerts.

### P3: observability, so regressions are caught

- [x] **P3.1** `utils/hypedexer-credit-meter.ts`, called from `core/base.api.service.ts` on every successful response carrying `X-Credit-Cost` (only HypeDexer sends it): calls and credits per upstream path (ids/addresses collapsed), logged once a minute as `HypeDexer credits (last minute)` with the last `X-Credit-Balance`.
- [x] **P3.2** Day total in Redis (`hypedexer:credits:YYYY-MM-DD`, UTC, shared by instances), one warning per process and day above `HYPEDEXER_DAILY_CREDIT_BUDGET` (default 300 000, raised to 1 000 000 on 2026-10-13: see `docs/DATA_BUDGET.md` §4.2). Logs only: `/api/health` is public.
- [x] **P3.3 Export quota.** A cancelled download gives the quota back up to 4 upstream pages (≈200 credits); past that the pages were paid for and the export counts. Upstream failures still give it back; local datasets never count.

**Expected result.** After P0+P1, per-visitor cost on the heavy pages drops by >90% and becomes mostly shared. After P2, the background is ~40–50k/day. At 1 000 users, total cost stays of the same order as with 10. **Measured: §8.**

## 6. Correctness bugs found during the audit (not credit issues)

- `/vaults/vaultLedger` always returns `[]`, even for HLP. The outflows leaderboard and the vault ledger table/charts are empty. *(Upstream; still true 2026-09-28.)*
- HIP-4 lists are truncated at 100 rows, the upstream default (max 1000): there are 342 questions, ≥1000 outcome tokens and 13 642 markets (16 206 on 2026-09-28). *(Worked around 2026-09-29: targeted reads, P1.3.)*
  - `markets-enriched` caches without `limit` in the key. Depending on who filled the cache (100 or 500 rows), a deep link to a non-live market redirects to `/market/hip4`. This was observed during the audit. *(Fixed 2026-09-28: every enriched key carries every param.)*
- Liquidations backfill fetches **1 page per run** (observed): `has_more`/`next_cursor` are lost by the envelope unwrap (`utils/hypedexer-api-response.util.ts`), so `GET /liquidations` also always answers `has_more:false`. *(Open.)*
- Several backend cache keys ignore filters, so the wrong data can be served. This comes from static analysis and was not verified one by one. *(Fixed 2026-09-28 for every item below: the user-scoped keys take the filters, `withFilters()` in `constants/hypedexer.cache.ts`.)* Affected:
  - fills: user fills, spot user fills
  - `users/:user/coins` (`limit`)
  - funding: userFunding + summary
  - EVM: bridge/ledger
  - hip3 user coins/fills
  - hip4 fills (`hip4Fills(user)` is called without filters)
  - twaps user
  - vault user equities
  - mixed-case addresses create duplicate keys *(only normalised where HypeDexer was checked case-insensitive: vault reads, funding summary)*
- `cacheService.getOrSet` re-runs `fetchFn` on failure for the leader and every waiter. Errors are free, but fan-outs rerun in full. *(Open.)*
- HIP-4 enrichment, found while doing P1.3 *(fixed 2026-09-29)*:
  - HypeDexer sends `settled` (0/1), not `is_settled`: every market read as open, so most questions stayed "live" (29 of the oldest 69 are settled). Its times are UTC without a zone, now sent with `Z`.
  - Rows 10–99 inherited empty fields from outcome `floor(id / 10)`, titling a bucket question's outcomes "BTC above 0 on May 4". Each row is its own market now; a row's side is never read from its id's last digit.
  - A question's outcomes were all named after the question ("2026 World Cup Champion" × 49): they carry their own names ("Algeria", "Draw", "Below 4.3%").
  - Filtered reads (`?outcome_id=`, `?question_id=`) return each row up to three times: one row per outcome now.
  - Front: a non-live market's card linked to the indexer's raw label `#<raw>`, which is another market's coin (`#20` is outcome 2's Yes side, with its fills). Cards link to `#<10*raw>`.

## 7. How to re-measure (do it after each fix batch)

The tools are in `~/lt-perf-tests/hypedexer-audit/`; see its README. The raw 2026-09-25 run is in `2026-09-25/`.

1. **Start the proxy.** `proxy.js` listens on :4555 (HTTP) and :4556 (WS).
2. **Start an isolated backend** from built `dist/`:
   - `PORT=3012 REDIS_URL=redis://localhost:6379/1`
   - `HL_INDEXER_API_URL=http://127.0.0.1:4555`
   - `HYPEDEXER_WS_URL` / `HYPEDEXER_LIVEDATA_WS_URL` pointing to :4556
   - `ALLOWED_ORIGINS` including :3010
3. **Build a front copy** from `git archive HEAD`, with `node_modules` as a hardlink copy (`cp -al`; Turbopack refuses a symlink outside the root), then `next start` on :3010.
4. **Run the sweep and the reports:**
   - `FLUSH=1 node sweep.mjs 90 out.jsonl <routes…>`
   - `node sweep-report.js out.jsonl <proxy>/http.jsonl 15 --detail`
   - `report.js` / `balance.js` for the background.
5. **Leave other sessions alone.** Other Claude sessions often use :3000, :3002 and the shared `.next`: never reuse them. Kill only your own PIDs, and `redis-cli -n 1 flushdb` at the end.

The audit itself cost ~19.7k credits (1 266 calls).

## 8. Re-measure after the fixes (2026-09-28)

Same method and pages as §3–4, against back `perf/step-3` @ `091321f` + the working tree and front `perf/step-1` @ `491ee19` + the working tree (isolated copies, :3012 / :3010, Redis DB 1). Raw data: `~/lt-perf-tests/hypedexer-audit/2026-09-28/run/`. The user-scoped key fix of §6 landed after this run (it only splits entries that used to be shared by mistake). "Before" figures come from the 2026-09-25 raw sweep (`sweep-report.js`). The sweep tools there also flush `liquidations:list:*` / `liquidations:top:*`, and count `/liquidations/recent?limit=100` as page traffic (no longer a poller).

### Background, 0 visitors (25 min window)

| Poller | Credits/day before | After |
|---|---|---|
| `/liquidations/recent?limit=100` every 15 s | 68k | 0 (removed) |
| `/builders/list` | 41k (5 min) | 14k (15 min) |
| `users/active` ×4 | 34k (2 min) | 14k (5 min) |
| `top-traders` ×4 | 20k (2 min) | 8k (5 min) |
| metrics snapshot + backfill | 2k | 2k |
| **Total** | **~165k** | **~38k** |

### Cost per page (one visible tab, credits/min in steady state)

"Cold first load" is the first visitor after the caches expired: it fills the shared entries. "Warm first load" is the next visitor within the TTLs.

| Page | Before | After | Cold first load | Warm first load |
|---|---|---|---|---|
| `/market/hip4/[non-live question]` (#173) | ~1 280 | 14 | 964 | 38 |
| `/explorer/vaults/[HLP]` | ~460 | 0 | 569 | 0 |
| `/explorer/vaults` | ~400 | 0 | 774 | 0 |
| `/explorer/address/[wallet]` | ~420 | 8 | 530 | — |
| `/market/tracker/wallet/[wallet]` | ~520 (§4) | 10 | 539 | — |
| `/dashboard/market` | ~170 | 3 | 383 | 6 |
| `/market/hip4` | ~100–136 | 14 | 404 | 7 |
| `/market/hip4/[coin]` (#12090) | ~180 | 79 (shared tape, see below) | 361 | — |
| `/market/builders` | ~126 | 5 | 9 | — |
| `/market/builders/intelligence` | ~128 | 18 | 9 | — |
| `/market/perpdex/xyz/GOLD` | ~56 | 29 | 19 | — |
| `/market` | ~30 | 5 | 84 | — |
| `/explorer` | ~24 | 15 | 27 | — |
| `/market/trades` | ~12 | 2 | 18 | — |
| others | ≤ 12 | ≤ 12 | | |

Every page answered without an error. What is left per page is mostly shared now: a second visitor adds nothing until the TTLs run out. The biggest remaining steady cost is the live HIP-4 coin tape (`/hip4/fills?coin&limit=400` every 15 s, ~42 credits per refresh): one visitor pays ~80 credits/min, a thousand pay the same.

This re-measure cost 9.9k credits (677 calls).

### Decisions left

- ~~**HIP-4 truncation (P1.3).**~~ Decided 2026-09-29: targeted `/hip4/markets?outcome_id=` reads (option B, see P1.3). HypeDexer ignores every sort param on `/hip4/markets` (checked: `order`, `sort_dir`, `sort`, `settled`, `is_settled`) and orders by `outcome_id` ascending, but honors the `outcome_id` and `question_id` filters (3 credits a market). A full walk would be 17 pages ≈ 1.7k credits per refresh (16 506 markets on 2026-09-29, +450–850 a day).
- **P2.5 `allFills`** and **P2.4** (separate effort).

