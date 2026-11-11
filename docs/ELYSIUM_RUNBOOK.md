# Elysium ingestion: what to do when

What to look at and what to do when the Elysium ingestion (HypeDexer → historical database →
analytics views) needs a hand. Every limit and cadence quoted here is listed in
[`DATA_BUDGET.md`](./DATA_BUDGET.md); the switches are described in `.env.example`.

`$BACK` below is the backend's public URL.

## 1. Where to look first

One route says whether the data is fresh and complete, and is public:

```bash
curl -s "$BACK/elysium/analytics/status" | jq '.data | {partial, streams: [.streams[] | {stream, state, lagSeconds, lastOkAt, lastError}], provider, rollups, completeness: {differing: .completeness.differing}, rejects, upkeep}'
```

The same with how the service is run is for an admin (a Privy token of an account whose role is
ADMIN, as the admin pages send it): what the provider bills, the size of the database and of
the tables, the row count of each stream, how long each view takes.

```bash
curl -s -H "Authorization: Bearer $ADMIN_TOKEN" "$BACK/elysium/analytics/status/ops" | jq '.data | {credits, database, rollups, streams: [.streams[] | {stream, rows}], views: [.views[] | {view, lastDurationMs}]}'
```

| Field | What it says |
| --- | --- |
| `streams[].state` | `ok`, `failing` (its last run failed, `lastError` says how), `stalled` (no completed run for 3 of its periods and 5 minutes: its loop does not run), `behind` (its data is late while the provider is not), `waiting-provider` (its data stops where the provider's index stops), `backfilling` (it runs and has not read the chain's history to the end yet: a new database or a new stream) |
| `streams[].lastOkAt` | when the stream last completed a run, with or without rows to write |
| `streams[].lagSeconds` | age of the stream's data; for `bridge`, the age of its newest transfer (no fault: nobody may have bridged for hours); `null` for the streams whose cursor is the time of their run (`tokens`, `methods`, `tokenstats`, `launchstats`) and for the RPC fallback `txlive` |
| `partial` | the parts of the status that could not be read at this computation (`rollups`, `database`, `rejects`, `completeness`, `credits`): shown empty, and to be read as unknown |
| `provider` | the provider's last indexed block time and how far behind the clock it is |
| `rollups` | built days, closed days waiting for their rollup, the builder's last error (admin route: the disk they take, the days kept) |
| `completeness` | for the last 7 closed days: our transaction count and the provider's, and `differing` |
| `rejects` | what was read and not stored, per stream and reason, today / yesterday / 7 days |
| `upkeep` | the one-time jobs (`launchstate`, `kilngrads`, `bridgedeep`, …) and whether they are done |
| `credits` (admin route) | HypeDexer credits per UTC day (8 days), today's most expensive paths, the balance |
| `database` (admin route) | size of the historical database, and its share of the volume when `HISTORICAL_DB_VOLUME_BYTES` is set (the database alone: the write-ahead log and anything else on the volume are not counted, so the real share is a little higher) |
| `views` | each scheduled view: last computation, its last error (admin route: its duration, whether it is being watched or running) |
| `streams[].cursor` | the time each stream's data goes up to (the pages show it while the history loads) |
| `streams[].rows` (admin route) | how many rows each stream has written |

`GET $BACK/api/health` answers the process's uptime: after a deploy, a small uptime is the proof
the new image runs (the deploy status GitHub shows can be wrong, see section 10).

## 2. The messages

Once a minute the backend reads that status and sends a message to `ELYSIUM_ALERT_WEBHOOK_URL`
(a Discord or Slack webhook, or Telegram's `sendMessage` with `ELYSIUM_ALERT_TELEGRAM_CHAT_ID`)
when something has been wrong for long enough, again every 6 hours while it lasts, and once when
it has been over for 5 minutes. Without a URL the same lines go to the log
(`Elysium alert (no webhook set)`). What was already said is kept in Redis (`elysium:alerts`),
so a restart repeats nothing.

The loop runs in the process that serves the API, not in an ingestion-only worker
(`PROCESS_ROLE=elysium-worker`): the webhook's address goes on the API service. With Telegram's
address, `ELYSIUM_ALERT_TELEGRAM_CHAT_ID` is required: without it Telegram refuses every message
(an error says so in the log at start).

| Message | Sent after | Section |
| --- | --- | --- |
| `stream <name> is failing` | 3 min, or 3 of the stream's periods when that is longer (one failed run of a stream that runs every 15 min is not news) | 3 |
| `stream <name> is stalled / behind` | 3 min | 3 |
| `the provider's index has not moved for …` | 10 min of lag | 4 |
| `<day> still differs from the provider after being read again whole` | at once | 5 |
| `<day> differs from the provider and is still not equal` | 3 h (the daily check is reading it again meanwhile) | 5 |
| `the day rollups fail` / `N closed days wait for their rollups` | 10 min / 30 min | 6 |
| `N <reason> on the <stream> stream today` | at once, per stream and reason, for that day | 7 |
| `… HypeDexer credits spent today, over 1.3 times …` | at once, for that day | 8 |
| `the historical database fills N% of its volume` | at 80% | 9 |
| `the job <name> fails` / `the view <name> fails` | 10 min (scheduled views only) | 3 |
| `the status of the ingestion has not been computed for …` | 5 min | below |
| `the status of the ingestion could not be read for N min` | 5 looks in a row | below |

The last two mean the loop itself is blind: the status view fails or is not computed (look at
`views` for `elysium:analytics:status`, at the pages pool of the historical database, at Redis).
While that lasts nothing else is said, and nothing is said to be over. A part of the status that
could not be read (`partial`) is treated the same way for the conditions it feeds.

## 3. A stream is failing, stalled or behind

1. Read `lastError` and `lastOkAt` for the stream in the status.
   `lastError` is a category, not the raw message: `upstream_http_<code>`, `timeout`, `db_error`,
   `page_cap`, or `error` (the raw message is in the logs and in `elysium_ingest_state.last_error`).
2. `failing` with `upstream_http_5xx` or `timeout`: the provider answers badly. Nothing to do
   here: the stream retries at its own cadence and no row is skipped (the cursor only moves once
   a window is stored). Check section 4.
3. `failing` with `upstream_http_401`, `402` or `403`: the HypeDexer key or its credits. Check
   the key (`HL_INDEXER_API_KEY`) and the balance (`credits.balance`).
4. `failing` with `db_error`: look at the database (section 9), then at what holds it:

   ```sql
   SELECT pid, state, wait_event_type, now() - xact_start AS for, left(query, 120) AS query
   FROM pg_stat_activity
   WHERE datname = current_database() AND state <> 'idle'
   ORDER BY xact_start;
   ```

   The writers' connections end a statement after 10 minutes, a lock wait after 1 minute and an
   idle open transaction after 5 minutes, so nothing of ours stays stuck longer than that.
5. `stalled`: the stream's loop does not run. Is there a process that runs the ingestion
   (`ELYSIUM_INGEST_ENABLED` not `false`; or the service with `PROCESS_ROLE=elysium-worker`)? Is
   it up (`/api/health`, Railway logs)? A run that stands still is given up on its own (5 minutes
   without reaching its next page, write or window; 20 for `tokens`, the rollups and the launch
   state) and the next one starts: the stream then shows `failing` with `tick_time_limit`. A run
   that keeps moving on is left alone for up to 6 times that, after which the stream takes a
   window half as long. A lock left by a process that died (`poll:elysium-ingest:<stream>` in
   Redis) expires by itself within 2 minutes. If the process is up and the stream still does not
   run, restart the service.
6. `behind` (`tx`, `dex`, `launchpad`: the chain never stops, so late data is a fault): for `dex`
   and `launchpad`, which read logs from the RPC, the RPC is slow or refuses (`lastError`), or a
   backlog is being read after an outage: the lag then shrinks run after run. The `bridge` is
   never `behind`: its lag is the age of its newest transfer.

A job of `upkeep` or a view in error: the message quotes the error category. A view keeps
serving its last value while it fails; it is computed again at its cadence.

## 4. The provider's index stands still

`provider.lagSeconds` grows and `tx` / `bridge` are `waiting-provider`. This is HypeDexer's
indexer, not ours:

- recent transactions keep coming from the RPC (`txlive`), DEX and launchpad logs too; the
  bridge and the token registry wait;
- nothing is lost: when the index moves again the `tx` stream reads on from its cursor, and the
  daily comparison (section 5) checks each closed day afterwards;
- tell HypeDexer, with `provider.headAt` (the time of their last indexed block).

## 5. A closed day differs from the provider

Every 30 minutes the last 7 closed UTC days are compared with the provider's `/stats/daily`
(table `elysium_day_check`). A day that differs for 30 minutes is read again, slot of 10 minutes
by slot, our emptiest slots first; rows are added, corrected, or removed (only rows the provider
says twice, 10 minutes apart, it does not know, and never more than the day holds in excess).

```sql
SELECT day, status, our_txs, provider_txs, our_spam, provider_spam, rereads,
       rows_added, rows_corrected, rows_removed, gap_since, repaired_at
FROM elysium_day_check ORDER BY day DESC;
```

- `gap` / `repairing`: being handled; a whole day is at most 144 slots.
- `unrepaired`: read again whole twice and still different, so reading it again will not help
  (the provider's daily figure and its transaction list disagree). It stands until the
  provider's figure changes. To have it read again anyway:

  ```sql
  UPDATE elysium_day_check SET status = 'gap', rereads = 0, progress = NULL WHERE day = '2026-11-10';
  ```

- A re-read misbehaves: `ELYSIUM_DAY_CHECK_REMOVE=false` keeps the comparison and the inserts and
  removes nothing; `ELYSIUM_DAY_CHECK_ENABLED=false` stops the whole check. Both without a deploy
  (a variable and a restart).

A whole re-read of one day costs up to about 300,000 HypeDexer credits.

## 6. The rollups are late or fail

The analytics read closed days from the day rollups and the rest from `elysium_tx`. A day
without a rollup is still served, from the raw table, slower, with the same figures.

- `rollups.waitingDays` above 1 for long, or `rollups.lastError`: the builder (it runs with the
  ingestion). A day that fails is tried again after 5 minutes, then 10, up to 6 hours, and the
  other days are built meanwhile.
- To build a day again (figures you do not trust):

  ```sql
  UPDATE elysium_day_rollup SET dirty = true WHERE day = '2026-11-10';
  ```

  The views stop reading that day's rollup at once and read the raw table until it is built
  again (a day takes from a few seconds to a few minutes).
- The rollups themselves are the suspect: `ELYSIUM_ROLLUPS_ENABLED=false` on every service makes
  every view read the raw table alone, as before 2026-11-10 (the long windows get much slower).
- Disk: `ELYSIUM_ROLLUP_KEEP_DAYS` (63 by default) is how many days are kept.

## 7. Rows were left out

`rejects` in the status, and one example per stream, reason and day in the database:

```sql
SELECT day, stream, reason, count, sample FROM elysium_ingest_reject ORDER BY day DESC, count DESC LIMIT 40;
```

| Reason | What it means | What to do |
| --- | --- | --- |
| `launch-unknown-emitter` | a launch event from a contract that is not on the launchpads' list | spam, or a new version of a launchpad: check the address of the sample, add it to the list if it is one |
| `market-unknown` | a trade or a graduation for a token never seen launching | a launch event was missed: check the launchpad's contracts and versions |
| `row-refused` | a row the database refused, set aside so its page is stored | read the sample: a value outside what the column takes |
| `window-truncated` | a window of logs cut at the page cap at the smallest step | rows are missing for that window: tell whoever maintains the ingestion |
| `reorg` | a block that left the chain: rows removed and read again | nothing, unless it repeats |
| `row-malformed`, `log-malformed`, `log-undecodable`, `text-truncated` | provider rows without their fields, logs that do not decode, texts cut to their column | a sudden rise means the provider changed a format |
| `token-unreadable`, `transfer-unreadable` | a token or a transfer the provider would not give; tried again later | nothing, unless it lasts |
| `day-gap` | a closed day that differs | section 5 |

## 8. Credits

`credits.days` is the spend per UTC day, `credits.topPathsToday` where today's went,
`credits.balance` what the provider says is left. What makes a day abnormal is almost always a
backfill or a re-read:

- a day being read again (section 5): up to about 300,000 credits per day read;
- a fresh database: every stream reads the chain from its start;
- a stream after a long outage of the provider.

If the spend has to stop now: `ELYSIUM_DAY_CHECK_ENABLED=false` (re-reads), then
`ELYSIUM_INGEST_ENABLED=false` (all the streams; the pages keep serving what is stored, recent
transactions excepted). `HYPEDEXER_DAILY_CREDIT_BUDGET` (1,000,000 by default) is the day's
total past which the log warns, once per process and day.

## 9. The database volume fills up

`database.usedShare` (set `HISTORICAL_DB_VOLUME_BYTES` to the volume's size in bytes, 100 GB =
107374182400, or the share is not known and no message is sent).

1. See what takes the room:

   ```sql
   SELECT relname, pg_size_pretty(pg_total_relation_size(oid)) AS size
   FROM pg_class WHERE relkind = 'r' AND relnamespace = 'public'::regnamespace
   ORDER BY pg_total_relation_size(oid) DESC LIMIT 15;
   ```

2. Grow the volume (Railway resizes it live, no restart), then update `HISTORICAL_DB_VOLUME_BYTES`.
3. Free room without losing data: fewer rollup days (`ELYSIUM_ROLLUP_KEEP_DAYS`, never under 10).
4. Do not let it reach 100%: a full volume stops every write, and Postgres itself can stop. The
   streams then fail and read on from their cursors once there is room; what they could not
   store meanwhile is read again from the provider, as long as it keeps its history.

How long the raw transactions are kept is a decision still to take (see the audit report).

## 10. Deploying, and going back

- Order: backend first, then the frontend. The backend's pre-deploy step applies the migrations.
- With an ingestion-only worker service next to the API service: deploy the worker first, or
  both together. The alerts of the API service tell a stream that runs by the time of its last
  completed run, which only the code of 2026-11-11 and later writes: an older worker beside a
  newer API would have every stream said to be stalled.
- After a push, check `GET $BACK/api/health`: a small uptime means the new image runs. During a
  Railway incident a deploy can wait an hour or more: do not trigger it again.
- A pre-deploy that fails with `P1001` (database unreachable) is on Railway's side: Redeploy.
- Going back: redeploy the previous deployment from Railway's dashboard. The Elysium migrations
  only add tables, columns and indexes, so the previous image runs on the newer schema; no
  migration has to be undone.
- Going back on one behaviour without a deploy (a variable, then a restart):

| Variable | `false` means |
| --- | --- |
| `ELYSIUM_INGEST_ENABLED` | this process runs no ingestion stream (nor the rollup builder, nor the daily check) |
| `ELYSIUM_ROLLUPS_ENABLED` | no rollup is built or read; every view reads the raw table (set it on every service) |
| `ELYSIUM_DAY_CHECK_ENABLED` | closed days are no longer compared nor read again |
| `ELYSIUM_DAY_CHECK_REMOVE` | the daily check still adds and corrects, and removes nothing |
| `ELYSIUM_ALERTS_ENABLED` | no message is sent |

## 11. The tests that run the SQL

The unit tests mock the database. The statements themselves run in `tests/db`, on a real
Postgres, in CI (job `db`) and locally:

```bash
createdb elysium_test
export HISTORICAL_DATABASE_URL=postgresql://<user>:<password>@localhost:5432/elysium_test
npm run prisma:migrate:historical
TEST_HISTORICAL_DATABASE_URL=$HISTORICAL_DATABASE_URL npm run test:db
```

They empty the Elysium tables as they go, and refuse to run on a database whose name does not
hold `test` or `scratch` as a word (`elysium_test`, not `latest`), or that is not on the machine
they run on (`TEST_DB_ALLOW_REMOTE=1` allows it). A change to a statement of the ingestion, of
the daily check, of the rollups or of a view gets its test there.

## 12. Three things not to do

- Do not run the backend locally against an empty database with the ingestion on for more than
  a few minutes: the streams start reading the whole chain, and after 30 minutes the daily check
  starts reading whole days again (hundreds of thousands of credits). Use
  `ELYSIUM_INGEST_ENABLED=false`, or `ELYSIUM_DAY_CHECK_ENABLED=false`.
- Do not ask production for every analytics route at once to "warm" them: the views are computed
  on a schedule, one at a time; asking for all of them only queues behind it.
- Do not put the alert webhook's address in a log, a ticket or a message: it is a secret (anyone
  who has it can post in the channel).
