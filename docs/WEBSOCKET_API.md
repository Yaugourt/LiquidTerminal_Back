# WebSocket API Documentation

## Overview

LiquidTerminal provides a real-time WebSocket API for liquidation data at `/ws`. This is the recommended way to receive real-time liquidations (replaces SSE for new integrations).

## Connection

```
ws://your-domain.com/ws
wss://your-domain.com/ws  (production)
```

### Connection Limits
- **Max connections per IP**: 5
- **Max total connections**: 1000
- **Max messages per second**: 10

## Protocol

All messages are JSON encoded.

### Client → Server Messages

#### Subscribe to Liquidations

```json
{
  "method": "subscribe",
  "subscription": {
    "type": "liquidation",
    "filters": {
      "coins": ["BTC", "ETH"],
      "minAmountUsd": 100000,
      "wallets": ["0x..."]
    }
  }
}
```

**Filter options** (all optional):
- `coins`: Array of coin symbols to filter (e.g., `["BTC", "ETH"]`)
- `minAmountUsd`: Minimum notional value in USD
- `wallets`: Array of liquidated wallet addresses

#### Subscribe to an L4 Order Book

```json
{
  "method": "subscribe",
  "subscription": {
    "type": "l4book",
    "coin": "BTC"
  }
}
```

`coin` is required and works across every market type: perps (`BTC`), spot
(`@107`, `PURR/USDC`), HIP-3 assets (`xyz:SKHX`) and HIP-4 outcomes (`#10250`).
A connection may hold **4 books at once**; each extra coin is a separate
subscribe.

#### Unsubscribe

```json
{
  "method": "unsubscribe",
  "subscription": {
    "type": "liquidation"
  }
}
```

For `l4book`, pass the `coin` to drop one book; omitting it drops every book on
that connection.

#### Ping (keep-alive)

```json
{
  "method": "ping"
}
```

### Server → Client Messages

#### Connected (on connection)

```json
{
  "type": "connected",
  "data": {
    "clientId": "uuid-string"
  },
  "timestamp": "2026-02-01T12:00:00.000Z"
}
```

#### Subscribed (confirmation)

```json
{
  "type": "subscribed",
  "data": {
    "type": "liquidation",
    "filters": {
      "coins": ["BTC"]
    }
  },
  "timestamp": "2026-02-01T12:00:00.000Z"
}
```

#### Liquidation Event

```json
{
  "type": "liquidation",
  "data": {
    "tid": 123456,
    "time": "2026-02-01T12:00:00",
    "time_ms": 1738411200000,
    "coin": "BTC",
    "hash": "0x...",
    "liquidated_user": "0x...",
    "size_total": 1.5,
    "notional_total": 150000,
    "fill_px_vwap": 100000,
    "mark_px": 100100,
    "liq_dir": "Long",
    "liquidator_count": 3,
    "aggregation": {
      "isAggregated": true,
      "count": 3,
      "timeRangeMs": [1738411200000, 1738411200500],
      "originalTids": [123454, 123455, 123456],
      "totalNotional": 150000,
      "avgMarkPrice": 100100
    }
  },
  "timestamp": "2026-02-01T12:00:00.500Z"
}
```

**Note**: When multiple liquidations occur for the same user/coin/direction within 1 second, they are aggregated into a single event with weighted average prices.

#### L4 Order Book Snapshot

Sent once, right after `subscribed`. Levels are tuples — `[price, size,
restingOrders, uniqueMakers]` — ordered best-first (bids descending, asks
ascending), capped at `depth` levels per side.

```json
{
  "type": "l4book_snapshot",
  "data": {
    "coin": "HYPE",
    "time": 1786105575364,
    "depth": 100,
    "bids": [[56.861, 4.38, 1, 1], [56.858, 122.4, 2, 2]],
    "asks": [[56.866, 18.01, 1, 1]],
    "totals": {
      "bidSize": 515432.1, "askSize": 636210.7,
      "bidNotional": 29300000, "askNotional": 36200000,
      "bidOrders": 6112, "askOrders": 5365,
      "bidLevels": 3376, "askLevels": 2772,
      "makers": 1950
    }
  },
  "timestamp": "2026-08-07T12:00:00.000Z"
}
```

`totals` covers the **entire** book, not just the shipped ladder — that is the
part Hyperliquid's public `l2Book` (20 levels) cannot report at all.

#### L4 Order Book Delta

Sent at most every 250 ms, carrying only the levels that moved. A level with
size `0` has left the ladder and should be dropped.

```json
{
  "type": "l4book_delta",
  "data": {
    "coin": "HYPE",
    "time": 1786105575614,
    "bids": [[56.861, 9.02, 2, 2], [56.84, 0, 0, 0]],
    "asks": [],
    "totals": { "…": "same shape as the snapshot" }
  },
  "timestamp": "2026-08-07T12:00:00.250Z"
}
```

#### L4 Order Book Unavailable

The coin has no live book (delisted HIP-3 asset, settled HIP-4 outcome).

```json
{
  "type": "l4book_unavailable",
  "data": { "coin": "cash:GOLD", "reason": "no_book" },
  "timestamp": "2026-08-07T12:00:00.000Z"
}
```

**Accuracy note**: the upstream `l4Book` delta stream does not announce every
departing order (verified 2026-08-07 on HYPE: 10 of 10 resting asks the price
traded through vanished with no `remove` diff). The server therefore rebuilds
each watched book from a fresh upstream snapshot every `L4BOOK_RESYNC_MS`
(default 8 s) and immediately on detecting a crossed book, which it never
publishes. Clients that need tick-exact top-of-book should still overlay
Hyperliquid's public `l2Book` for the levels it covers.

#### Heartbeat (response to ping)

```json
{
  "type": "heartbeat",
  "timestamp": "2026-02-01T12:00:00.000Z"
}
```

#### Error

```json
{
  "type": "error",
  "error": "Rate limit exceeded",
  "code": "RATE_LIMIT",
  "timestamp": "2026-02-01T12:00:00.000Z"
}
```

**Error codes**:
- `RATE_LIMIT`: Too many messages per second
- `INVALID_FORMAT`: Message is not valid JSON
- `UNKNOWN_METHOD`: Unknown method in request
- `INVALID_SUBSCRIPTION`: Invalid subscription type
- `INVALID_COIN`: `l4book` subscribe without a usable `coin`
- `TOO_MANY_BOOKS`: More than 4 `l4book` subscriptions on one connection
- `BOOK_CAPACITY`: The server is already mirroring its maximum number of books

## Connection Health

The server sends pings every 30 seconds. Clients that don't respond with pong within 60 seconds are disconnected.

Clients can also send `"method": "ping"` to test the connection.

## Example: JavaScript/TypeScript Client

```typescript
const ws = new WebSocket('wss://api.liquidterminal.com/ws');

ws.onopen = () => {
  console.log('Connected');
  
  // Subscribe to liquidations
  ws.send(JSON.stringify({
    method: 'subscribe',
    subscription: {
      type: 'liquidation',
      filters: {
        minAmountUsd: 100000
      }
    }
  }));
};

ws.onmessage = (event) => {
  const message = JSON.parse(event.data);
  
  switch (message.type) {
    case 'connected':
      console.log('Client ID:', message.data.clientId);
      break;
      
    case 'subscribed':
      console.log('Subscribed with filters:', message.data.filters);
      break;
      
    case 'liquidation':
      const liq = message.data;
      console.log(`${liq.coin} ${liq.liq_dir}: $${liq.notional_total.toLocaleString()}`);
      break;
      
    case 'error':
      console.error('Error:', message.error, message.code);
      break;
  }
};

ws.onerror = (error) => {
  console.error('WebSocket error:', error);
};

ws.onclose = (event) => {
  console.log('Disconnected:', event.code, event.reason);
  // Implement reconnection logic here
};
```

## Example: Python Client

```python
import asyncio
import json
import websockets

async def connect():
    uri = "wss://api.liquidterminal.com/ws"
    
    async with websockets.connect(uri) as ws:
        # Subscribe
        await ws.send(json.dumps({
            "method": "subscribe",
            "subscription": {
                "type": "liquidation",
                "filters": {
                    "minAmountUsd": 100000
                }
            }
        }))
        
        # Listen for messages
        async for message in ws:
            data = json.loads(message)
            
            if data["type"] == "liquidation":
                liq = data["data"]
                print(f"{liq['coin']} {liq['liq_dir']}: ${liq['notional_total']:,.2f}")

asyncio.run(connect())
```

## Migration from SSE

If you're currently using SSE (`/liquidations/stream`), here's how to migrate:

| SSE | WebSocket |
|-----|-----------|
| `new EventSource('/liquidations/stream')` | `new WebSocket('wss://host/ws')` + subscribe message |
| Query params: `?coins=BTC,ETH` | Filters in subscription: `{ filters: { coins: ["BTC", "ETH"] } }` |
| Query params: `?minAmount=100000` | Filters: `{ filters: { minAmountUsd: 100000 } }` |
| Query params: `?wallets=0x...` | Filters: `{ filters: { wallets: ["0x..."] } }` |
| Auto-reconnect built-in | Implement reconnection in client |
| `event: liquidation` | `message.type === 'liquidation'` |

**Key differences**:
1. WebSocket is bidirectional - you can update filters without reconnecting
2. WebSocket has lower latency than SSE
3. WebSocket requires explicit subscription after connection
4. Both SSE and WebSocket are available during migration period

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    LiquidTerminal Backend                        │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌──────────────────────┐     ┌──────────────────────┐          │
│  │  HypeDexer WS Client │────▶│ LiquidationsWSService│          │
│  │  (external WS)       │     │ (aggregation logic)  │          │
│  └──────────────────────┘     └──────────┬───────────┘          │
│                                          │                       │
│              ┌───────────────────────────┼───────────────┐       │
│              │                           │               │       │
│              ▼                           ▼               ▼       │
│  ┌──────────────────────┐   ┌──────────────────┐  ┌──────────┐  │
│  │ InternalWebSocketSrv │   │ SSEManagerService│  │ Telegram │  │
│  │ (/ws endpoint)       │   │ (/stream - legacy)│  │ Bot API  │  │
│  └──────────────────────┘   └──────────────────┘  └──────────┘  │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

## Environment Variables

No additional environment variables required. Uses existing `HL_INDEXER_API_KEY` for HypeDexer connection.
