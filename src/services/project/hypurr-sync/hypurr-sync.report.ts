import { SyncDiff, SyncField } from './hypurr-sync.types';

/** Counters for logs and the CLI header. */
export function summarizeDiff(diff: SyncDiff): Record<string, number> {
  const fillable = diff.matched.reduce((n, m) => n + m.diffs.filter((d) => d.fillable).length, 0);
  const conflicting = diff.matched.reduce((n, m) => n + m.diffs.filter((d) => !d.fillable).length, 0);
  return {
    hypurr: diff.hypurrCount,
    lt: diff.ltCount,
    matched: diff.matched.length,
    missing: diff.missing.length,
    ltOnly: diff.ltOnly.length,
    ambiguous: diff.ambiguous.length,
    fillableFields: fillable,
    differingFields: conflicting,
  };
}

/** Per-field counts: how many matched projects LT could fill vs where both have different values. */
export function fieldStats(diff: SyncDiff): Record<SyncField, { fillable: number; differs: number }> {
  const fields: SyncField[] = ['website', 'twitter', 'telegram', 'discord', 'logo', 'description', 'token', 'categories'];
  const out = Object.fromEntries(fields.map((f) => [f, { fillable: 0, differs: 0 }])) as Record<
    SyncField,
    { fillable: number; differs: number }
  >;
  for (const m of diff.matched) {
    for (const d of m.diffs) {
      if (d.fillable) out[d.field].fillable++;
      else out[d.field].differs++;
    }
  }
  return out;
}

const short = (s: string | null, max = 70): string => {
  if (s == null) return '(empty)';
  const one = s.replace(/\s+/g, ' ');
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
};

/** Human-readable dry-run diff. */
export function formatDiff(diff: SyncDiff, opts: { verbose?: boolean } = {}): string {
  const s = summarizeDiff(diff);
  const lines: string[] = [];
  lines.push(
    `Hypurr projects: ${s.hypurr} | LT projects: ${s.lt} | matched: ${s.matched} | ` +
      `missing from LT: ${s.missing} | LT-only: ${s.ltOnly} | ambiguous keys: ${s.ambiguous}`
  );

  const byReason = diff.matched.reduce<Record<string, number>>((acc, m) => {
    acc[m.reason] = (acc[m.reason] ?? 0) + 1;
    return acc;
  }, {});
  lines.push(`Matched by: ${Object.entries(byReason).map(([k, v]) => `${k}=${v}`).join(', ') || '-'}`);

  lines.push('', `== Missing from LT (${diff.missing.length}) -> created by --apply ==`);
  for (const h of [...diff.missing].sort((a, b) => a.name.localeCompare(b.name))) {
    lines.push(`  + ${h.name} | ${h.website ?? '(no website)'} | ${h.twitter ?? '(no X)'} | ${h.categories.join(', ') || '-'}`);
  }

  lines.push('', '== Field differences on matched projects ==');
  for (const [field, c] of Object.entries(fieldStats(diff))) {
    lines.push(`  ${field.padEnd(12)} fillable (LT empty): ${String(c.fillable).padStart(3)} | differs (kept as is): ${String(c.differs).padStart(3)}`);
  }
  for (const m of diff.matched) {
    const shown = opts.verbose ? m.diffs : m.diffs.filter((d) => d.fillable || d.field !== 'description');
    if (shown.length === 0) continue;
    lines.push(`  ~ ${m.lt.title} (#${m.lt.id}, by ${m.reason}${m.lt.title !== m.hypurr.name ? `, Hypurr "${m.hypurr.name}"` : ''})`);
    for (const d of shown) {
      lines.push(`      ${d.fillable ? 'FILL' : 'DIFF'} ${d.field}: LT=${short(d.lt)} | Hypurr=${short(d.hypurr)}`);
    }
  }

  lines.push('', `== On LT but not on Hypurr (${diff.ltOnly.length}) -> report only, never deleted ==`);
  for (const p of [...diff.ltOnly].sort((a, b) => a.title.localeCompare(b.title))) {
    lines.push(`  - ${p.title} (#${p.id}) | ${p.website ?? '(no website)'}`);
  }

  if (diff.ambiguous.length > 0) {
    lines.push('', '== Ambiguous keys (skipped) ==');
    for (const a of diff.ambiguous) lines.push(`  ? ${a.key}: ${a.ltTitles.join(' / ')}`);
  }
  return lines.join('\n');
}
