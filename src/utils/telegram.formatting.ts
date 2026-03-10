import { AggregatedLiquidation } from '../types/liquidations.types';

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
