import { AggregatedLiquidation } from '../types/liquidations.types';
import { AggregatedFill } from '../types/fill-alerts.types';

/**
 * Format a dollar amount in a human-readable way
 */
export function formatAmount(amount: number): string {
  if (amount >= 1_000_000) {
    return `$${(amount / 1_000_000).toFixed(2)}M`;
  }
  if (amount >= 1_000) {
    return `$${(amount / 1_000).toFixed(1)}K`;
  }
  return `$${amount.toFixed(0)}`;
}

/**
 * Format a price in USD
 */
export function formatPrice(price: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(price);
}

/**
 * Escape HTML special characters for Telegram HTML parse mode
 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatTimeRange(timeRange: [number, number]): string {
  const durationMs = timeRange[1] - timeRange[0];
  const durationSec = Math.round(durationMs / 1000);

  if (durationSec < 60) {
    return `${durationSec}s`;
  }

  const minutes = Math.floor(durationSec / 60);
  const seconds = durationSec % 60;
  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

/**
 * Format a liquidation alert message for Telegram (HTML parse mode)
 */
export function formatLiquidationAlert(liq: AggregatedLiquidation): string {
  const directionEmoji = liq.liq_dir === 'Long' ? '🟢' : '🔴';
  const trendEmoji = liq.liq_dir === 'Long' ? '📉' : '📈';
  const amountFormatted = formatAmount(liq.notional_total);
  const priceFormatted = formatPrice(liq.mark_px);
  const timeFormatted = liq.time.slice(0, 16).replace('T', ' ');

  const liquidTerminalTx = `https://liquidterminal.xyz/explorer/transaction/${liq.hash}`;
  const liquidTerminalAddress = `https://liquidterminal.xyz/explorer/address/${liq.liquidated_user}`;
  const hypurrscanTx = `https://hypurrscan.io/tx/${liq.hash}`;
  const hypurrscanAddress = `https://hypurrscan.io/address/${liq.liquidated_user}`;

  const isAggregated = liq.aggregation?.isAggregated;
  const aggregationInfo = isAggregated
    ? `\n📊 <b>${liq.aggregation!.count} liquidations agrégées</b> (${formatTimeRange(liq.aggregation!.timeRangeMs)})`
    : '';

  return `
🚨 <b>LIQUIDATION ALERT</b>${aggregationInfo}

${directionEmoji} <b>${escapeHtml(liq.coin)}</b> ${liq.liq_dir}: ${amountFormatted}
${trendEmoji} Mark Price: ${priceFormatted}
🕐 ${timeFormatted} UTC

<b>📝 Transaction</b>
<a href="${liquidTerminalTx}">Liquid Terminal</a> • <a href="${hypurrscanTx}">Hypurrscan</a>
<code>${escapeHtml(liq.hash)}</code>

<b>👛 Liquidated Wallet</b>
<a href="${liquidTerminalAddress}">Liquid Terminal</a> • <a href="${hypurrscanAddress}">Hypurrscan</a>
<code>${escapeHtml(liq.liquidated_user)}</code>

━━━━━━━━━━━━━━━━━━━━
<i>Data by <a href="https://app.hypedexer.com/">HypeDexer</a> (Enigma Validator)</i>
<a href="https://x.com/liquidterminal">𝕏</a> • <a href="https://liquidterminal.xyz/">Website</a>
`.trim();
}

/**
 * Format a token price with adaptive precision (small prices keep more decimals)
 */
function formatTokenPrice(price: number): string {
  if (!Number.isFinite(price)) return '$0';
  if (price >= 1) {
    return `$${price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }
  if (price >= 0.01) return `$${price.toFixed(4)}`;
  return `$${price.toPrecision(4)}`;
}

/**
 * Shorten an Ethereum address for display (e.g. 0x1234…abcd)
 */
function shortenAddress(address: string): string {
  if (address.length <= 12) return address;
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/**
 * Format a fill timestamp (perp = epoch ms number, spot = ISO-8601 string)
 * to a compact `YYYY-MM-DD HH:MM` UTC string.
 */
function formatFillTime(time: string | number): string {
  const iso = typeof time === 'number' ? new Date(time).toISOString() : time;
  return iso.slice(0, 16).replace('T', ' ');
}

/**
 * Format a fill size with adaptive precision — small sizes keep more decimals
 * so sub-1 amounts aren't rounded away (e.g. 0.0034 instead of 0.003).
 */
function formatSize(sz: number): string {
  if (!Number.isFinite(sz)) return '0';
  const maximumFractionDigits = Math.abs(sz) >= 1 ? 4 : 8;
  return sz.toLocaleString('en-US', { maximumFractionDigits });
}

/**
 * Format a signed PnL value as `+$X` / `-$X` using formatAmount() under the hood
 * (formatAmount always returns a positive `$X` — we just prepend the sign here).
 */
function formatSignedPnl(pnl: number): string {
  const sign = pnl >= 0 ? '+' : '-';
  return `${sign}${formatAmount(Math.abs(pnl))}`;
}

/**
 * Format a duration in milliseconds as a compact `Xs` or `Xm Ys` string.
 * Mirrors `formatTimeRange` used by liquidations.
 */
function formatDurationMs(durationMs: number): string {
  const durationSec = Math.round(durationMs / 1000);
  if (durationSec < 60) return `${durationSec}s`;
  const minutes = Math.floor(durationSec / 60);
  const seconds = durationSec % 60;
  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

/**
 * Format a Fill alert message for Telegram (HTML parse mode).
 * Driven by HypeDexer `allFills` (perp) and `fills_spot` (spot) — an executed order.
 */
export function formatFillAlert(fill: AggregatedFill, subscriptionName: string): string {
  const isBuy = fill.side === 'B';
  const sideEmoji = isBuy ? '🟢' : '🔴';
  const sideLabel = isBuy ? 'BUY' : 'SELL';
  const sourceTag = fill.source === 'perp' ? 'PERP' : 'SPOT';
  const twapTag = fill.twapId != null ? ' <code>TWAP</code>' : '';

  const liquidTerminalAddress = `https://liquidterminal.xyz/explorer/address/${fill.wallet}`;
  const hypurrscanAddress = `https://hypurrscan.io/address/${fill.wallet}`;

  const dirLine =
    fill.source === 'perp' && fill.dir ? `\n🧭 Direction: ${escapeHtml(fill.dir)}` : '';

  // The order may have been filled in several fills — show the count + flag VWAP.
  const isAggregated = fill.fillCount > 1;
  const priceLabel = isAggregated ? ' <i>(VWAP)</i>' : '';
  const durationSuffix =
    isAggregated && fill.aggregationDurationMs !== undefined
      ? ` (${formatDurationMs(fill.aggregationDurationMs)})`
      : '';
  const fillCountLine = isAggregated
    ? `\n🧩 Filled in ${fill.fillCount} fills${durationSuffix}`
    : '';

  // Realized PnL line — perp only, hidden when 0 or undefined.
  const pnlLine =
    fill.closedPnlTotal !== undefined && fill.closedPnlTotal !== 0
      ? `\n💰 Realized PnL: ${fill.closedPnlTotal > 0 ? '🟢' : '🔴'} ${formatSignedPnl(fill.closedPnlTotal)}`
      : '';

  // TWAP orders aren't tied to a single transaction hash — replace the
  // transaction block with the TWAP id instead.
  const transactionBlock =
    fill.twapId != null
      ? `<b>🧵 TWAP</b> <code>${escapeHtml(String(fill.twapId))}</code>`
      : (() => {
          const liquidTerminalTx = `https://liquidterminal.xyz/explorer/transaction/${fill.hash}`;
          const hypurrscanTx = `https://hypurrscan.io/tx/${fill.hash}`;
          return `<b>📝 Transaction</b>
<a href="${liquidTerminalTx}">Liquid Terminal</a> • <a href="${hypurrscanTx}">Hypurrscan</a>
<code>${escapeHtml(fill.hash)}</code>`;
        })();

  return `
💸 <b>FILL ALERT</b> <code>${sourceTag}</code>${twapTag} · <i>${escapeHtml(subscriptionName)}</i>

${sideEmoji} <b>${escapeHtml(fill.coin)}</b> ${sideLabel}
💵 Notional: ${formatAmount(fill.notionalUsd)}
📦 Size: ${formatSize(fill.sz)} @ ${formatTokenPrice(fill.px)}${priceLabel}${pnlLine}${fillCountLine}${dirLine}
🕐 ${formatFillTime(fill.time)} UTC

${transactionBlock}

<b>👛 Wallet</b> <code>${escapeHtml(shortenAddress(fill.wallet))}</code>
<a href="${liquidTerminalAddress}">Liquid Terminal</a> • <a href="${hypurrscanAddress}">Hypurrscan</a>

━━━━━━━━━━━━━━━━━━━━
<i>Data by <a href="https://app.hypedexer.com/">HypeDexer</a> (Enigma Validator)</i>
<a href="https://x.com/liquidterminal">𝕏</a> • <a href="https://liquidterminal.xyz/">Website</a>
`.trim();
}
