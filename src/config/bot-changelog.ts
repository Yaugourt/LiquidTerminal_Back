/**
 * Bot changelog — one entry per deployed version.
 *
 * To announce a new update:
 *   1. Bump CURRENT_BOT_VERSION
 *   2. Write the announcement message below
 *   3. Deploy → BotAnnouncementService broadcasts automatically to all users
 */

export const CURRENT_BOT_VERSION = '1.3.0';

export const BOT_ANNOUNCEMENT_MESSAGE = `🆕 <b>Bot Update — v${CURRENT_BOT_VERSION}</b>

Here's what's new:

📚 <b>Hyperliquid Docs alerts</b>
The bot now monitors the Hyperliquid documentation automatically. Whenever a page is updated, you'll be notified here — no setup needed.

🔘 <b>Docs button in menu</b>
A new <b>📚 Docs</b> button has been added to the main menu. Tap it anytime to get info about the doc monitoring feature.

━━━━━━━━━━━━━━━━━━━━
<a href="https://liquidterminal.xyz/">Liquid Terminal</a> • <a href="https://x.com/liquidterminal">𝕏</a>`.trim();
