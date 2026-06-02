# Backend feature prompt template

When prompting an agent to build a feature that **derives values from a live or
external feed** (HypeDexer, Hyperliquid `info`, Hypurrscan, DefiLlama, the local
DB…), a good interface spec is not enough. The `followers-gained` leaderboard
shipped returning `[]` — it compiled, returned a valid `200`, and was wrong —
because the prompt specified the *what* (endpoints, shapes, cache keys) but never
the *truths of the real data*, and "done" was declared on "compiles" instead of
"non-empty against real data".

Use the sections below. The two load-bearing ones are **§2 (data invariants)**
and **§4 (verify against real data)** — skip them and you reproduce the bug.

---

## §1 — Interface (the "what")

- Endpoints + HTTP methods, request params, response shapes (TypeScript).
- Cache keys + TTL, error codes, pagination/limits.

## §2 — Data invariants (the "real feed truths") — MANDATORY

State every assumption the implementation will make about the upstream data, and
whether it actually holds. The OpenAPI often does **not** document this (e.g.
`docs/hypedexer_endpoints.json` declares response bodies as untyped blobs — field
names, types and units are reverse-engineered).

- **Cadence / timeliness.** "Daily snapshots are *nominally* daily but slip 2-4
  days. Never assume a record exists at `now - window`. Select the baseline by
  **index/rank**, not an absolute time cutoff." (This exact assumption caused the
  empty leaderboard: `snaps.find(sn => sn.time <= now - 24h)` matched the latest
  snapshot itself → delta 0 → filtered out.)
- **Field units & sign.** `time` = epoch ms? seconds? ISO string? (mixed across
  this codebase). `amount` = signed? already USD? Spell it out — a seconds-vs-ms
  mismatch silently empties any time-windowed sum.
- **Field presence.** Which fields can be `null`/absent? An absent `followerCount`
  makes a delta `NaN` that fails a `> 0` filter silently.
- **Cardinality.** Some entities have < N records — handle short/empty series.

## §3 — Edge cases & sampling caveats

- Empty / short series, missing fields → define behaviour (omit vs zero vs error).
- **Selection bias.** A candidate pool sorted by *current count* cannot surface
  top *growth* (the `followers-gained` pool is top-50-by-followerCount, so it can
  only ever find big vaults that grow, never breakout vaults). Either widen the
  pool or surface the bias in `meta`.

## §4 — Verify against real data (the Definition of Done) — MANDATORY

- `curl` the endpoint against staging/prod (or a locally-running back).
- **Assert each result is non-empty** for every window (e.g. `24h` AND `7d`).
- **Assert sanity ranges**, e.g. `followersGained[].delta > 0`,
  `outflows[].amountUsd < 0`, `|percentOfTvl| <= 1`, `tvl > 0`, `computedAt`
  within the TTL.
- **Paste ≥3 rows of real curl output into the PR.** A `200` with `[]` is NOT done.

## §5 — Test requirement

- A **service-level** unit test with a fixture of *slipped, sparse* snapshots
  that reproduces the index-vs-time-cutoff trap.
- A route smoke test that **mocks the service** does NOT count as coverage for the
  computation — it passes whether the board returns 5 rows or `[]`.

---

## Worked example — the leaderboards prompt, corrected

> Implement `GET /indexer/vaults/leaderboards/followers-gained?window=24h|7d&limit=N`.
> Shape: `{ vaultAddress, name, leader, tvl, delta, total }[]`. Cache under
> `hypedexer:vaults:leaderboards:{window}`, TTL 5 min. **[§1]**
>
> Data invariants: HypeDexer daily snapshots slip 2-4 days — pick the baseline as
> the **N-th prior snapshot by index** (1 for 24h, 7 for 7d), never by
> `now - window`. `followerCount` may be absent on a snapshot. **[§2]**
>
> The candidate pool (top-50 by current followerCount) is biased toward large
> vaults — note this in `meta`, don't pretend it's a global ranking. **[§3]**
>
> Done = `curl` both windows against the local back, paste ≥3 non-empty rows,
> confirm every `delta > 0`. Add a service test with a slipped-snapshot fixture. **[§4/§5]**
