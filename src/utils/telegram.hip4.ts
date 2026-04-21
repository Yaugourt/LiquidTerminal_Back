import { createHash } from 'crypto';
import type { Hip4EventPayload } from '../types/hip4-events.types';

/** Keywords that trigger Telegram broadcast (intersection with `payload.keywords`). */
export const HIP4_ALERT_KEYWORDS = new Set<string>([
  'registerOutcome',
  'registerTokensAndStandaloneOutcome',
  'registerQuestion',
  'registerNamedOutcome',
  'registerOutcomeToken',
  'settleOutcome',
  'changeOutcomeDescription',
  'changeQuestionDescription',
  'setOutcomeFeeScale',
  'splitOutcome',
  'mergeOutcome',
  'mergeQuestion',
  'negateOutcome',
]);

const KEYWORD_LABELS_FR: Record<string, string> = {
  registerOutcome: 'Nouveau marché outcome (standalone)',
  registerTokensAndStandaloneOutcome: 'Enregistrement token + outcome',
  registerQuestion: 'Question multi-outcomes',
  registerNamedOutcome: 'Named outcome ajouté à une question',
  registerOutcomeToken: 'Token de collatéral enregistré',
  settleOutcome: 'Résolution oracle (0 / 1 / fraction)',
  changeOutcomeDescription: 'Métadonnées outcome mises à jour',
  changeQuestionDescription: 'Métadonnées question mises à jour',
  setOutcomeFeeScale: 'Grille de frais (governance)',
  splitOutcome: 'Split — collatéral → YES + NO',
  mergeOutcome: 'Merge — YES + NO → collatéral',
  mergeQuestion: 'Merge question (multi-outcome)',
  negateOutcome: 'Negate — flip YES ↔ NO',
};

/**
 * Normalize JSON `raw` so equivalent objects produce the same dedupe key (sorted keys).
 */
export function normalizeHip4RawForDedupe(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return '';
  if (trimmed[0] !== '{' && trimmed[0] !== '[') {
    return raw;
  }
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return stableJsonStringify(parsed);
  } catch {
    return raw;
  }
}

function stableJsonStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableJsonStringify(v)).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableJsonStringify(obj[k])}`).join(',')}}`;
}

/**
 * Stable dedupe key for one on-chain HIP-4 event (shared across all users).
 */
export function buildHip4EventDedupeKey(payload: Hip4EventPayload): string {
  const rawIn = payload.raw ?? '';
  const raw = normalizeHip4RawForDedupe(rawIn);
  const height = payload.block_height ?? '';
  const kw = [...payload.keywords].sort().join(',');
  const input = `${height}|${kw}|${raw}`;
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/**
 * Returns matched alert keywords (subset of HIP4_ALERT_KEYWORDS), or empty if none.
 */
export function getMatchedHip4AlertKeywords(keywords: string[]): string[] {
  const out: string[] = [];
  for (const k of keywords) {
    if (HIP4_ALERT_KEYWORDS.has(k)) {
      out.push(k);
    }
  }
  return out;
}

/**
 * Resolve a 0x transaction hash from explicit fields or JSON `raw`.
 */
export function extractHip4TxHash(payload: Hip4EventPayload): string | undefined {
  const candidates = [payload.tx_hash, payload.hash];
  for (const c of candidates) {
    if (typeof c === 'string' && isLikelyTxHash(c)) {
      return c;
    }
  }
  if (!payload.raw || payload.raw.length === 0) {
    return undefined;
  }
  try {
    const j = JSON.parse(payload.raw) as Record<string, unknown>;
    const keys = ['hash', 'tx_hash', 'transaction_hash', 'txHash', 'tx', 'transactionHash'];
    for (const key of keys) {
      const v = j[key];
      if (typeof v === 'string' && isLikelyTxHash(v)) {
        return v;
      }
    }
  } catch {
    // not JSON
  }
  return undefined;
}

function isLikelyTxHash(s: string): boolean {
  return /^0x[a-fA-F0-9]{64}$/.test(s.trim());
}

function formatHip4TimeUtc(blockTime?: string, detectedAt?: string): string | undefined {
  const src = blockTime ?? detectedAt;
  if (!src) return undefined;
  const normalized = src.includes('T') ? src.slice(0, 16).replace('T', ' ') : src.slice(0, 16);
  return `${normalized} UTC`;
}

/**
 * HTML Telegram message for HIP-4 — same structure as `formatLiquidationAlert` (header, tx links, footer).
 */
export function formatHip4TelegramMessage(payload: Hip4EventPayload, matchedKeywords: string[]): string {
  const lines: string[] = [];

  lines.push(`🎯 <b>HIP-4 ALERT</b>`);
  lines.push('');

  for (const k of matchedKeywords) {
    const label = KEYWORD_LABELS_FR[k] ?? k;
    lines.push(`• <code>${escapeHtml(k)}</code> — ${escapeHtml(label)}`);
  }

  const timeLine = formatHip4TimeUtc(payload.block_time, payload.detected_at);
  if (timeLine) {
    lines.push(`🕐 ${escapeHtml(timeLine)}`);
  }

  if (payload.block_height !== undefined) {
    lines.push(`📦 Block: <code>${escapeHtml(String(payload.block_height))}</code>`);
  }

  const txHash = extractHip4TxHash(payload);
  if (txHash) {
    const liquidTerminalTx = `https://liquidterminal.xyz/explorer/transaction/${txHash}`;
    const hypurrscanTx = `https://hypurrscan.io/tx/${txHash}`;
    lines.push('');
    lines.push(`<b>📝 Transaction</b>`);
    lines.push(`<a href="${liquidTerminalTx}">Liquid Terminal</a> • <a href="${hypurrscanTx}">Hypurrscan</a>`);
    lines.push(`<code>${escapeHtml(txHash)}</code>`);
  }

  if (payload.raw && payload.raw.length > 0) {
    const snippet = payload.raw.length > 450 ? `${payload.raw.slice(0, 450)}…` : payload.raw;
    lines.push('');
    lines.push(`<b>📄 Event</b>`);
    lines.push(`<pre>${escapeHtml(snippet)}</pre>`);
  }

  lines.push('');
  lines.push(`━━━━━━━━━━━━━━━━━━━━`);
  lines.push(`<i>Data by <a href="https://app.hypedexer.com/">HypeDexer</a> (Enigma Validator)</i>`);
  lines.push(`<a href="https://x.com/liquidterminal">𝕏</a> • <a href="https://liquidterminal.xyz/">Website</a>`);

  return lines.join('\n').trim();
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
