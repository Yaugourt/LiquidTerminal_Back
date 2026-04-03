/**
 * Extract GET operations with required query parameters from docs/hypedexer_endpoints.json.
 * Writes docs/hypedexer-required-query.json for drift checks vs Zod indexer schemas.
 *
 * Run: npm run hypedexer:required-query
 */
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '..');
const SPEC_PATH = path.join(ROOT, 'docs', 'hypedexer_endpoints.json');
const OUT_JSON = path.join(ROOT, 'docs', 'hypedexer-required-query.json');

interface OpenApiDoc {
  paths?: Record<
    string,
    Record<
      string,
      {
        parameters?: Array<{ name?: string; in?: string; required?: boolean }>;
      }
    >
  >;
}

function main(): void {
  const raw = fs.readFileSync(SPEC_PATH, 'utf8');
  const doc = JSON.parse(raw) as OpenApiDoc;
  const paths = doc.paths ?? {};
  const entries: Array<{
    path: string;
    method: string;
    requiredQuery: string[];
    allQuery: string[];
  }> = [];

  for (const [p, methods] of Object.entries(paths)) {
    for (const [method, op] of Object.entries(methods)) {
      if (method === 'parameters' || !op || typeof op !== 'object') continue;
      const params = op.parameters ?? [];
      const queryParams = params.filter((x) => x.in === 'query');
      const requiredQuery = queryParams.filter((x) => x.required).map((x) => x.name ?? '');
      if (requiredQuery.length === 0) continue;
      entries.push({
        path: p,
        method: method.toLowerCase(),
        requiredQuery,
        allQuery: queryParams.map((x) => `${x.name ?? ''}${x.required ? '*' : ''}`),
      });
    }
  }

  entries.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));

  const payload = {
    generatedFrom: path.relative(ROOT, SPEC_PATH),
    generatedAt: new Date().toISOString(),
    count: entries.length,
    operations: entries,
  };

  fs.writeFileSync(OUT_JSON, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  console.log(`Wrote ${entries.length} operation(s) with required query → ${path.relative(ROOT, OUT_JSON)}`);
}

main();
