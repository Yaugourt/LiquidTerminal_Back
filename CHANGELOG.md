# Changelog

What changed for the people who use Liquid Terminal or its API, in plain words, newest first.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). There are no version numbers: `main` is deployed to production, so a section is the date a change reached `main`.

How to use it: every pull request whose change is visible to a user adds one line under `[Unreleased]`, in the right group (Added, Changed, Fixed, Removed, Security). While there, it moves the lines of pull requests already merged under the date of their merge.

## [Unreleased]

### Added

- The traders' leaderboard of the API ranks 7 days, 30 days or all time, page by page, with PnL, win rate and account value.

## 2026-11-26

### Added

- The traders export ranks 7 days, 30 days or all time, with PnL, win rate and account value.

### Fixed

- The exports of the traders, the top traders and the active users work again: they always failed.
- The exports of liquidations, vaults and builders no longer hold the same rows over and over.
- The dates picked for an export of HIP-3 fills, HIP-4 fills or funding are applied. They were ignored.
- The funding export holds up to 5,000 hours instead of 500.
- Filters that did nothing are no longer offered (the size of spot fills, the order of HyperEVM, HIP-3 and HIP-4 rows), and the order of completed trades is applied.

## 2026-11-25

### Added

- Preview deployments of the site can read the API and its live streams. They cannot change anything through it.

## 2026-11-12

### Changed

- Elysium analytics over long windows (7 days, 30 days) answer much faster.
- An Elysium contract profile is served from its last reading for up to 2 minutes, an address profile for up to 10 minutes.
- An Elysium launch lists its 20 largest holders.
- The public Elysium status says less about how the service is run, and still gives the time each stream's data goes up to.
- Routes that read the data indexer have a budget per client, so one heavy visitor cannot use up what everyone shares.

### Fixed

- When Redis is down, the request limits keep counting and recently fetched data is still served.

## 2026-11-11

### Added

- The Elysium status route says how each stream is really doing.
- Each closed day of Elysium data is compared with the provider and read again when it differs.

### Changed

- Elysium analytics are computed in the background on a schedule, so a visit never waits for a computation.
- The Elysium launchpad list is served 200 rows at a time.

### Fixed

- The Elysium fees total counts every fee, as the economics page does.
- Kiln graduations are stored, their history included.
- Launch prices and the names of new launches are right.
- The Elysium bridge data leaves no period unread and follows late status changes.
- One token that cannot be read no longer blocks the holder stats.
- A quiet bridge is no longer reported as late, and a stream reading its history for the first time is no longer reported as behind.

### Security

- Request bodies are counted per client before any route.
- WebSocket connection limits are applied at the handshake, and a flooding socket is closed.
- The Elysium RPC proxy weighs calls by the work they ask and keeps a share for each client.

## 2026-11-10

### Added

- Live Elysium mainnet blocks over the WebSocket.
- A read-only JSON-RPC proxy to the Elysium mainnet node.
- Each Elysium launch keeps its last price and what its curve sold.

### Changed

- Elysium analytics over wide windows are faster.
- The Elysium launchpad token list is served by pages instead of whole.

### Fixed

- An invalid frame on a refused WebSocket connection no longer stops the server.

### Security

- The Elysium RPC proxy counts every call and bounds what a call can ask.
- Elysium list routes count against each client's budget.

## 2026-11-05

### Fixed

- The leaderboard works again.

### Security

- Secrets stay hidden in the logs even when the log files cannot be created.

## 2026-11-04

### Fixed

- The TWAP list no longer empties when a live-data connection drops.
- Short stalls of the API caused by Redis writing to disk are gone.
