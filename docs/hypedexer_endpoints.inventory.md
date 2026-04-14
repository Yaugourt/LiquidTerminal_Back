# HypeDexer (HL Indexer) OpenAPI inventory

> **Generated** by `npm run hypedexer:inventory`. Do not edit by hand; regenerate after updating `docs/hypedexer_endpoints.json`.

## Proxied via `/indexer/*` (hypedexer/rest)

| Method | Upstream path | Notes |
|--------|---------------|-------|
| GET | `/fills/` | HypeDexerFillsClient + /indexer/fills |
| GET | `/fills/recent` | HypeDexerFillsClient + /indexer/fills/recent |
| GET | `/fills/count` | HypeDexerFillsClient + /indexer/fills/count |
| GET | `/fills/user/{user_address}` | HypeDexerFillsClient + /indexer/fills/user/:user_address |
| GET | `/fills/spot/` | HypeDexerFillsClient + /indexer/fills/spot |
| GET | `/fills/spot/user/{user_address}` | HypeDexerFillsClient + /indexer/fills/spot/user/:user_address |
| GET | `/funding/fundingHistory` | HypeDexerFundingClient + /indexer/funding/fundingHistory |
| GET | `/funding/predictedFundings` | … + /indexer/funding/predictedFundings |
| GET | `/funding/userFunding` | … + /indexer/funding/userFunding |
| GET | `/users/leaderboard` | HypeDexerUsersIndexerClient + /indexer/users/leaderboard |
| GET | `/overview/active-traders-24h` | HypeDexerOverviewIndexerClient + /indexer/overview/active-traders-24h |
| GET | `/overview/coin-distribution` | … + /indexer/overview/coin-distribution |
| GET | `/overview/daily-pnl-10d` | … + /indexer/overview/daily-pnl-10d |
| GET | `/overview/daily-volume-10d` | … + /indexer/overview/daily-volume-10d |
| GET | `/overview/total-fees-24h` | … + /indexer/overview/total-fees-24h |
| GET | `/overview/total-fills-24h` | … + /indexer/overview/total-fills-24h |
| GET | `/overview/trading-volume-24h` | … + /indexer/overview/trading-volume-24h |
| GET | `/analytics/fills/stats` | HypeDexerAnalyticsIndexerClient + /indexer/analytics/fills/stats |
| GET | `/analytics/priority-fees/stats` | HypeDexerAnalyticsIndexerClient + /indexer/analytics/priority-fees/stats |
| GET | `/analytics/priority-fees/fills-timeseries` | IndexerPriorityFeesAggregationService (aggregates GET /fills/) + /indexer/analytics/priority-fees/fills-timeseries |
| GET | `/builders/list` | HypeDexerBuildersIndexerClient + /indexer/builders/list |
| GET | `/builders/stats` | … + /indexer/builders/stats |
| GET | `/builders/stats/all-timeframes` | … + /indexer/builders/stats/all-timeframes |
| GET | `/builders/top` | … + /indexer/builders/top |
| GET | `/builders/{builder_address}/stats` | … + /indexer/builders/:builder_address/stats |
| GET | `/builders/{builder_address}/users` | … + /indexer/builders/:builder_address/users |
| GET | `/completed-trades/` | HypeDexerCompletedTradesClient + /indexer/completed-trades |
| GET | `/completed-trades/summary` | … + /indexer/completed-trades/summary |
| GET | `/completed-trades/{trade_id}/fills` | … + /indexer/completed-trades/:trade_id/fills |
| GET | `/hip3/assets` | HypeDexerHip3Client + /indexer/hip3/assets |
| GET | `/hip3/assets/{ticker}` | … + /indexer/hip3/assets/:ticker |
| GET | `/hip3/dexs` | … + /indexer/hip3/dexs |
| GET | `/hip3/dexs/{dex_id}` | … + /indexer/hip3/dexs/:dex_id |
| GET | `/hip3/overview` | … + /indexer/hip3/overview |
| GET | `/hip3/priority-fees/gossip/status` | HypeDexerHip3Client + /indexer/hip3/priority-fees/gossip/status |
| GET | `/hip3/priority-fees/gossip/history` | HypeDexerHip3Client + /indexer/hip3/priority-fees/gossip/history |
| GET | `/hip3/auctions` | … + /indexer/hip3/auctions |
| GET | `/hip3/auctions/current` | … + /indexer/hip3/auctions/current |
| GET | `/hip3/auctions/history` | … + /indexer/hip3/auctions/history |
| GET | `/hip3/fills` | … + /indexer/hip3/fills |
| GET | `/hip3/leaderboard` | … + /indexer/hip3/leaderboard |
| GET | `/hip3/ohlcv` | … + /indexer/hip3/ohlcv |
| GET | `/hip3/oracle/stats` | … + /indexer/hip3/oracle/stats |
| GET | `/hip3/snapshots` | … + /indexer/hip3/snapshots |
| GET | `/hip3/stats/traders` | … + /indexer/hip3/stats/traders |
| GET | `/hip3/top-movers` | … + /indexer/hip3/top-movers |
| GET | `/hip3/users/{address}/coins` | … + /indexer/hip3/users/:address/coins |
| GET | `/hip3/users/{address}/fills` | … + /indexer/hip3/users/:address/fills |
| GET | `/hip3/users/{address}/overview` | … + /indexer/hip3/users/:address/overview |
| GET | `/spot/auctions/hist` | HypeDexerSpotIndexerClient + /indexer/spot/auctions/hist |
| GET | `/spot/auctions/live` | … + /indexer/spot/auctions/live |
| GET | `/spot/pairs` | … + /indexer/spot/pairs |
| GET | `/spot/tokens` | … + /indexer/spot/tokens |
| GET | `/twaps/` | HypeDexerTwapsClient + /indexer/twaps |
| GET | `/twaps/stats` | … + /indexer/twaps/stats |
| GET | `/twaps/user/{user_address}` | … + /indexer/twaps/user/:user_address |
| GET | `/twaps/{twap_id}` | … + /indexer/twaps/:twap_id |
| GET | `/twaps/{twap_id}/fills` | … + /indexer/twaps/:twap_id/fills |
| GET | `/users/{user}/coins` | HypeDexerUsersIndexerClient + /indexer/users/:user/coins |
| GET | `/users/{user}/overview` | … + /indexer/users/:user/overview |
| GET | `/users/{user}/performance` | … + /indexer/users/:user/performance |
| GET | `/vaults/dailySnapshots` | HypeDexerVaultsIndexerClient + /indexer/vaults/dailySnapshots |
| GET | `/vaults/equitySnapshots` | … + /indexer/vaults/equitySnapshots |
| GET | `/vaults/userVaultEquities` | … + /indexer/vaults/userVaultEquities |
| GET | `/vaults/vaultDetails` | … + /indexer/vaults/vaultDetails |
| GET | `/vaults/vaultLedger` | … + /indexer/vaults/vaultLedger |
| GET | `/vaults/vaultSummaries` | … + /indexer/vaults/vaultSummaries |

## Summary

- **OpenAPI paths (operations):** 83
- **Implemented** (exact match to polling REST clients under hypedexer/rest): 71
- **Partial** (spec differs from current client URL): 0
- **Missing**: 11
- **WebSocket note** (`/ws`): 1

## Polling REST clients (hypedexer/rest — app routes)

| Method | Path | Source |
|--------|------|--------|
| GET | `/liquidations/` | rest/liquidations/liquidations.client.ts |
| GET | `/liquidations/recent` | rest/liquidations/liquidations.client.ts |
| GET | `/analytics/liquidations/stats` | rest/liquidations/liquidations.client.ts |
| GET | `/overview/top-traders-24h` | rest/toptraders/toptraders.client.ts |
| GET | `/users/active` | rest/activeusers/activeusers.client.ts |
| GET | `/builders/list` | rest/builders/builders-list-poller.client.ts (GET /builders/list?limit=1000&offset=0&sort=volume_usd&order=DESC) |

## Full operation matrix

| Status | Method | Path | Tags | operationId |
|--------|--------|------|------|-------------|
| Implemented | GET | `/analytics/fills/stats` | Analytics | `get_fills_stats_analytics_fills_stats_get` |
| Implemented | GET | `/analytics/liquidations/stats` | Analytics | `get_liquidations_stats_analytics_liquidations_stats_get` |
| Implemented | GET | `/analytics/priority-fees/stats` | Analytics | `get_priority_fees_stats_analytics_priority_fees_stats_get` |
| Implemented | GET | `/builders/list` | Builders | `list_builders_builders_list_get` |
| Implemented | GET | `/builders/stats` | Builders | `builder_global_stats_builders_stats_get` |
| Implemented | GET | `/builders/stats/all-timeframes` | Builders | `builder_stats_all_timeframes_builders_stats_all_timeframes_get` |
| Implemented | GET | `/builders/top` | Builders | `top_builders_builders_top_get` |
| Implemented | GET | `/builders/{builder_address}/stats` | Builders | `builder_detail_stats_builders__builder_address__stats_get` |
| Implemented | GET | `/builders/{builder_address}/users` | Builders | `builder_top_users_builders__builder_address__users_get` |
| Implemented | GET | `/completed-trades/` | Completed Trades | `list_completed_trades_completed_trades__get` |
| Implemented | GET | `/completed-trades/summary` | Completed Trades | `completed_trades_summary_completed_trades_summary_get` |
| Implemented | GET | `/completed-trades/{trade_id}/fills` | Completed Trades | `get_fills_for_trade_completed_trades__trade_id__fills_get` |
| Missing | GET | `/evm/blocks` | EVM | `get_blocks_evm_blocks_get` |
| Missing | GET | `/evm/blocks/{block_number}` | EVM | `get_block_evm_blocks__block_number__get` |
| Missing | GET | `/evm/blocks/{block_number}/transactions` | EVM | `get_block_transactions_evm_blocks__block_number__transactions_get` |
| Missing | GET | `/evm/bridge/events` | EVM | `get_bridge_events_evm_bridge_events_get` |
| Missing | GET | `/evm/ledger/transfers` | EVM | `get_ledger_transfers_evm_ledger_transfers_get` |
| Missing | GET | `/evm/logs` | EVM | `get_logs_evm_logs_get` |
| Missing | GET | `/evm/stats` | EVM | `get_stats_evm_stats_get` |
| Missing | GET | `/evm/stats/daily` | EVM | `get_daily_stats_evm_stats_daily_get` |
| Missing | GET | `/evm/transactions` | EVM | `get_transactions_evm_transactions_get` |
| Missing | GET | `/evm/user/{address}/ledger-events` | EVM | `get_user_ledger_events_evm_user__address__ledger_events_get` |
| Missing | GET | `/evm/user/{address}/ledger-summary` | EVM | `get_user_ledger_summary_evm_user__address__ledger_summary_get` |
| Implemented | GET | `/fills/` | Fills | `get_fills_fills__get` |
| Implemented | GET | `/fills/count` | Fills | `get_fills_count_fills_count_get` |
| Implemented | GET | `/fills/recent` | Fills | `get_fills_recent_fills_recent_get` |
| Implemented | GET | `/fills/spot/` | Spot | `get_fills_spot_fills_spot__get` |
| Implemented | GET | `/fills/spot/user/{user_address}` | Spot | `get_user_fills_spot_fills_spot_user__user_address__get` |
| Implemented | GET | `/fills/user/{user_address}` | Fills | `get_user_fills_fills_user__user_address__get` |
| Implemented | GET | `/funding/fundingHistory` | Funding | `funding_history_get_funding_fundingHistory_get` |
| Implemented | GET | `/funding/predictedFundings` | Funding | `predicted_fundings_get_funding_predictedFundings_get` |
| Implemented | GET | `/funding/userFunding` | Funding | `user_funding_get_funding_userFunding_get` |
| Implemented | GET | `/hip3/assets` | HIP-3 | `get_assets_hip3_assets_get` |
| Implemented | GET | `/hip3/assets/{ticker}` | HIP-3 | `get_asset_hip3_assets__ticker__get` |
| Implemented | GET | `/hip3/auctions` | HIP-3 | `get_auctions_hip3_auctions_get` |
| Implemented | GET | `/hip3/auctions/current` | HIP-3 | `get_auction_current_hip3_auctions_current_get` |
| Implemented | GET | `/hip3/auctions/history` | HIP-3 | `get_auctions_history_hip3_auctions_history_get` |
| Implemented | GET | `/hip3/dexs` | HIP-3 | `get_dexs_hip3_dexs_get` |
| Implemented | GET | `/hip3/dexs/{dex_id}` | HIP-3 | `get_dex_hip3_dexs__dex_id__get` |
| Implemented | GET | `/hip3/fills` | HIP-3 | `get_fills_hip3_fills_get` |
| Implemented | GET | `/hip3/leaderboard` | HIP-3 | `get_leaderboard_hip3_leaderboard_get` |
| Implemented | GET | `/hip3/ohlcv` | HIP-3 | `get_ohlcv_hip3_ohlcv_get` |
| Implemented | GET | `/hip3/oracle/stats` | HIP-3 | `get_oracle_stats_hip3_oracle_stats_get` |
| Implemented | GET | `/hip3/overview` | HIP-3 | `get_overview_hip3_overview_get` |
| Implemented | GET | `/hip3/priority-fees/gossip/history` | Priority Fees, HIP-3 | `get_gossip_history_hip3_priority_fees_gossip_history_get` |
| Implemented | GET | `/hip3/priority-fees/gossip/status` | Priority Fees, HIP-3 | `get_gossip_status_hip3_priority_fees_gossip_status_get` |
| Implemented | GET | `/hip3/snapshots` | HIP-3 | `get_snapshots_hip3_snapshots_get` |
| Implemented | GET | `/hip3/stats/traders` | HIP-3 | `get_trader_stats_hip3_stats_traders_get` |
| Implemented | GET | `/hip3/top-movers` | HIP-3 | `get_top_movers_hip3_top_movers_get` |
| Implemented | GET | `/hip3/users/{address}/coins` | HIP-3 | `get_user_coins_hip3_users__address__coins_get` |
| Implemented | GET | `/hip3/users/{address}/fills` | HIP-3 | `get_user_fills_hip3_users__address__fills_get` |
| Implemented | GET | `/hip3/users/{address}/overview` | HIP-3 | `get_user_overview_hip3_users__address__overview_get` |
| Implemented | GET | `/liquidations/` | Liquidations | `get_liquidations_liquidations__get` |
| Implemented | GET | `/liquidations/recent` | Liquidations | `get_liquidations_recent_liquidations_recent_get` |
| Implemented | GET | `/overview/active-traders-24h` | Overview | `active_traders_24h_overview_active_traders_24h_get` |
| Implemented | GET | `/overview/coin-distribution` | Overview | `coin_distribution_overview_coin_distribution_get` |
| Implemented | GET | `/overview/daily-pnl-10d` | Overview | `daily_pnl_10d_overview_daily_pnl_10d_get` |
| Implemented | GET | `/overview/daily-volume-10d` | Overview | `daily_volume_10d_overview_daily_volume_10d_get` |
| Implemented | GET | `/overview/top-traders-24h` | Overview | `top_traders_24h_overview_top_traders_24h_get` |
| Implemented | GET | `/overview/total-fees-24h` | Overview | `total_fees_24h_overview_total_fees_24h_get` |
| Implemented | GET | `/overview/total-fills-24h` | Overview | `total_fills_24h_overview_total_fills_24h_get` |
| Implemented | GET | `/overview/trading-volume-24h` | Overview | `trading_volume_24h_overview_trading_volume_24h_get` |
| Implemented | GET | `/spot/auctions/hist` | Spot | `get_spot_auctions_hist_spot_auctions_hist_get` |
| Implemented | GET | `/spot/auctions/live` | Spot | `get_spot_auctions_live_spot_auctions_live_get` |
| Implemented | GET | `/spot/pairs` | Spot | `get_spot_pairs_spot_pairs_get` |
| Implemented | GET | `/spot/tokens` | Spot | `get_spot_tokens_spot_tokens_get` |
| Implemented | GET | `/twaps/` | TWAPs | `list_twaps_twaps__get` |
| Implemented | GET | `/twaps/stats` | TWAPs | `twap_stats_twaps_stats_get` |
| Implemented | GET | `/twaps/user/{user_address}` | TWAPs | `user_twaps_twaps_user__user_address__get` |
| Implemented | GET | `/twaps/{twap_id}` | TWAPs | `get_twap_twaps__twap_id__get` |
| Implemented | GET | `/twaps/{twap_id}/fills` | TWAPs | `get_twap_fills_twaps__twap_id__fills_get` |
| Implemented | GET | `/users/active` | Users | `get_users_active_users_active_get` |
| Implemented | GET | `/users/leaderboard` | Users | `get_users_leaderboard_users_leaderboard_get` |
| Implemented | GET | `/users/{user}/coins` | Users | `get_user_coins_users__user__coins_get` |
| Implemented | GET | `/users/{user}/overview` | Users | `get_user_overview_users__user__overview_get` |
| Implemented | GET | `/users/{user}/performance` | Users | `get_user_performance_users__user__performance_get` |
| Implemented | GET | `/vaults/dailySnapshots` | Vaults | `vault_daily_snapshots_get_vaults_dailySnapshots_get` |
| Implemented | GET | `/vaults/equitySnapshots` | Vaults | `vault_equity_snapshots_get_vaults_equitySnapshots_get` |
| Implemented | GET | `/vaults/userVaultEquities` | Vaults | `user_vault_equities_get_vaults_userVaultEquities_get` |
| Implemented | GET | `/vaults/vaultDetails` | Vaults | `vault_details_get_vaults_vaultDetails_get` |
| Implemented | GET | `/vaults/vaultLedger` | Vaults | `vault_ledger_get_vaults_vaultLedger_get` |
| Implemented | GET | `/vaults/vaultSummaries` | Vaults | `vault_summaries_get_vaults_vaultSummaries_get` |
| WS (use websocket client, not REST) | GET | `/ws` | WebSocket | `—` |

## Redis / rate-limit notes

- Per-route weights are **not** present in this OpenAPI file; keep `REQUEST_WEIGHT` + `MAX_WEIGHT_PER_MINUTE` per **domain client** (see `constants/hypedexer.cache.ts`).
- Prefer **on-demand** + short TTL for heavy paths (e.g. `/fills/`); use **polling + distributed lock** only for hot aggregate keys.
