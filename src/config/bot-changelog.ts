/**
 * Bot changelog — one entry per deployed version.
 *
 * To announce a new update:
 *   1. Bump CURRENT_BOT_VERSION
 *   2. Write the announcement message below
 *   3. Deploy → BotAnnouncementService broadcasts automatically to all users
 */

export const CURRENT_BOT_VERSION = '1.4.1';

export const BOT_ANNOUNCEMENT_MESSAGE = `🆕 <b>Bot Update — v${CURRENT_BOT_VERSION}</b>

Here's what's new:

🎛️ <b>Advanced Fill filters</b>
Fine-tune your Fill alerts with four new filters: <b>Side</b> (Buy/Sell), <b>Source</b> (Perp/Spot), <b>Direction</b> (Open/Close) and <b>Max size</b>.

📉 <b>New preset — Position Closes</b>
One-tap alert on perp position closes above $50k.

💰 <b>Richer alerts</b>
Fill alerts now show <b>realized PnL</b> on close, the time window when an order is filled in pieces, and a dedicated <b>TWAP</b> block instead of an empty transaction.

🏠 <b>Refreshed main menu</b>
New welcome message and a compact grid layout — fewer scrolls, faster access.

━━━━━━━━━━━━━━━━━━━━
<a href="https://liquidterminal.xyz/">Liquid Terminal</a> • <a href="https://x.com/liquidterminal">𝕏</a>`.trim();
