/**
 * Bot changelog — one entry per deployed version.
 *
 * To announce a new update:
 *   1. Bump CURRENT_BOT_VERSION
 *   2. Write the announcement message below
 *   3. Deploy → BotAnnouncementService broadcasts automatically to all users
 */

export const CURRENT_BOT_VERSION = '1.4.0';

export const BOT_ANNOUNCEMENT_MESSAGE = `🆕 <b>Bot Update — v${CURRENT_BOT_VERSION}</b>

Here's what's new:

💸 <b>Fill Alerts</b>
Get notified the moment an order is executed on Hyperliquid — perp and spot. Filter by minimum size, token, and/or wallet.

⚡ <b>One-tap presets</b>
Spin up a Fill alert instantly: 🐋 Whale Fills, 📈 BTC/ETH/HYPE, 🎯 Altcoin Fills, 💥 Mega Orders — or set up your own filters.

🧾 <b>Fill Alerts button in menu</b>
A new <b>🧾 Fill Alerts</b> button has been added to the main menu. Manage your alerts anytime from /status.

━━━━━━━━━━━━━━━━━━━━
<a href="https://liquidterminal.xyz/">Liquid Terminal</a> • <a href="https://x.com/liquidterminal">𝕏</a>`.trim();
