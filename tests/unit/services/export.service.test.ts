import {
  csvCell,
  flattenRow,
  collectColumns,
  freezeWindow,
  redactRow,
} from '../../../src/services/export/export.service';
import { normalizeExportPage } from '../../../src/clients/hypedexer/rest/export/export-passthrough.client';
import { EXPORT_DATASETS, getExportDataset } from '../../../src/services/export/export.manifest';
import { LOCAL_SOURCES, getLocalSource } from '../../../src/services/export/export.local-sources';
import { EXPORT_MAX_ROWS } from '../../../src/constants/export.constants';

describe('csvCell', () => {
  it('leaves a plain value untouched', () => {
    expect(csvCell('HYPE')).toBe('HYPE');
    expect(csvCell(42)).toBe('42');
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
  });

  it('quotes and escapes per RFC 4180', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('line1\nline2')).toBe('"line1\nline2"');
  });

  // Regression: these are real vault names served by the upstream API today.
  // Without neutralisation each one executes on open in Excel/Sheets.
  it.each(['=1M=', '+convexity', '-VectorZero-', '@Alwaleed_Talal'])(
    'neutralises the formula trigger in %s',
    (name) => {
      const cell = csvCell(name);
      expect(cell.startsWith(`"'`)).toBe(true);
      expect(cell).toContain(name);
    }
  );

  it('neutralises a hyperlink payload', () => {
    expect(csvCell('=HYPERLINK("http://evil","click")')).toBe(
      `"'=HYPERLINK(""http://evil"",""click"")"`
    );
  });

  it('does not prefix negative numbers', () => {
    // A number cannot carry a payload, and prefixing would break the column.
    expect(csvCell(-12.5)).toBe('-12.5');
  });
});

describe('flattenRow', () => {
  it('flattens one level with a dotted key', () => {
    expect(flattenRow({ summary: { name: 'HLP', tvl: 12 } })).toEqual({
      'summary.name': 'HLP',
      'summary.tvl': 12,
    });
  });

  it('JSON-encodes arrays and deeper structures rather than dropping them', () => {
    expect(flattenRow({ tags: ['a', 'b'] })).toEqual({ tags: '["a","b"]' });
    expect(flattenRow({ a: { b: { c: 1 } } })).toEqual({ 'a.b': '{"c":1}' });
  });
});

describe('redactRow', () => {
  // The backend's own sources embed `creator: {id, name, email}` on their rows,
  // and the catalog discovers columns instead of declaring them — so without
  // this the wiki and read-list exports ship contributor emails.
  it('drops an email, flattened or not', () => {
    expect(redactRow({ 'creator.email': 'a@b.c', 'creator.name': 'alice' })).toEqual({
      'creator.name': 'alice',
    });
    expect(redactRow({ email: 'a@b.c' })).toEqual({});
  });

  it('drops internal moderation fields', () => {
    expect(redactRow({ reviewNotes: 'x', reviewedBy: 2, status: 'APPROVED' })).toEqual({
      status: 'APPROVED',
    });
  });

  it('drops the auth provider id', () => {
    expect(redactRow({ privyUserId: 'did:privy:123', name: 'alice' })).toEqual({ name: 'alice' });
  });

  it('drops a denied name at any path segment, not just the leaf', () => {
    // A renamed parent (`reviewer.email`) or a denied segment mid-path must not
    // slip through — the old leaf-only match let these survive.
    expect(redactRow({ 'reviewer.email': 'mod@x.io', 'reviewer.name': 'bob' })).toEqual({
      'reviewer.name': 'bob',
    });
    expect(redactRow({ 'submitter.reviewNotes.text': 'secret', ok: 1 })).toEqual({ ok: 1 });
  });

  it('keeps everything else untouched', () => {
    const row = { coin: 'HYPE', px: 58.4, 'summary.tvl': 12 };
    expect(redactRow(row)).toEqual(row);
  });
});

describe('collectColumns', () => {
  it('unions keys across rows, keeping first-seen order', () => {
    expect(collectColumns([{ a: 1, b: 2 }, { b: 3, c: 4 }])).toEqual(['a', 'b', 'c']);
  });

  it('returns nothing for no rows', () => {
    expect(collectColumns([])).toEqual([]);
  });
});

describe('normalizeExportPage', () => {
  it('reads a bare array', () => {
    const page = normalizeExportPage([{ a: 1 }, { a: 2 }]);
    expect(page.rows).toHaveLength(2);
    expect(page.totalCount).toBe(2);
  });

  it('reads an APIResponse envelope and keeps the pagination handles', () => {
    const page = normalizeExportPage({
      success: true,
      data: [{ a: 1 }],
      total_count: 99,
      next_cursor: 'abc',
      has_more: true,
    });
    expect(page.rows).toHaveLength(1);
    expect(page.totalCount).toBe(99);
    expect(page.nextCursor).toBe('abc');
    expect(page.hasMore).toBe(true);
  });

  it('keeps the outer handles when recursing into a nested envelope', () => {
    const page = normalizeExportPage({
      success: true,
      next_cursor: 'outer',
      data: { success: true, data: [{ a: 1 }] },
    });
    expect(page.rows).toHaveLength(1);
    expect(page.nextCursor).toBe('outer');
  });

  it('throws when the envelope reports failure', () => {
    expect(() => normalizeExportPage({ success: false, message: 'nope', data: null })).toThrow('nope');
  });

  it('reports zero rows for a non-list payload instead of coercing it', () => {
    expect(normalizeExportPage({ success: true, data: 42 }).rows).toEqual([]);
  });
});

describe('freezeWindow', () => {
  const dataset = getExportDataset('perp-fills')!;

  it('pins the end when the start is bounded', () => {
    const out = freezeWindow(dataset, { start_time: '2026-07-01T00:00:00Z' });
    expect(out.end_time).toBeDefined();
  });

  // An end_time with no start_time measured ~47s upstream against ~2s bounded.
  it('leaves an unbounded start alone', () => {
    expect(freezeWindow(dataset, {})).toEqual({});
  });

  it('never overwrites a caller-supplied end', () => {
    const params = { start_time: 'a', end_time: 'b' };
    expect(freezeWindow(dataset, params).end_time).toBe('b');
  });

  it('is a no-op for a dataset with no time window', () => {
    const spotPairs = getExportDataset('spot-pairs')!;
    expect(freezeWindow(spotPairs, {})).toEqual({});
  });
});

describe('export manifest', () => {
  it('has unique ids', () => {
    const ids = EXPORT_DATASETS.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('never exceeds the global row ceiling', () => {
    for (const dataset of EXPORT_DATASETS) {
      expect(dataset.maxRows).toBeLessThanOrEqual(EXPORT_MAX_ROWS);
    }
  });

  it('gives every param a label and every dataset a public path', () => {
    for (const dataset of EXPORT_DATASETS) {
      expect(dataset.publicPath).toMatch(/^\//);
      for (const param of dataset.params) {
        expect(param.label.length).toBeGreaterThan(0);
        if (param.type === 'enum') expect(param.options?.length).toBeGreaterThan(0);
      }
    }
  });

  // The two sources carry different obligations, and getting them wrong is a
  // 500 at download time rather than a compile error.
  it('backs every dataset with a usable source', () => {
    for (const dataset of EXPORT_DATASETS) {
      if (dataset.source === 'hypedexer') {
        expect(dataset.upstreamPath).toMatch(/^\//);
        expect(getLocalSource(dataset.id)).toBeUndefined();
      } else {
        expect(dataset.upstreamPath).toBe('');
        expect(typeof getLocalSource(dataset.id)).toBe('function');
      }
    }
  });

  it('keeps every page size inside what the source accepts', () => {
    for (const dataset of EXPORT_DATASETS) {
      if (dataset.pageSize === undefined) continue;
      expect(dataset.pageSize).toBeGreaterThan(0);
      expect(dataset.pageSize).toBeLessThanOrEqual(500);
    }
  });

  it('registers no orphan local resolver', () => {
    const localIds = new Set(
      EXPORT_DATASETS.filter((d) => d.source === 'local').map((d) => d.id)
    );
    for (const id of Object.keys(LOCAL_SOURCES)) {
      expect(localIds.has(id)).toBe(true);
    }
  });
});
