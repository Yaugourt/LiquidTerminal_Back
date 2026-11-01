/**
 * Sync the Liquid Terminal project directory with the Hypurr Collective ecosystem
 * (https://www.hypurr.co/ecosystem-projects).
 *
 * Dry run by default: prints the diff and writes nothing.
 *
 *   npm run hypurr:sync                               # dry run, LT read from the public API (no DB needed)
 *   npm run hypurr:sync -- --json out.json            # also dump the full diff as JSON
 *   npm run hypurr:sync -- --verbose                  # also list description differences
 *   npm run hypurr:sync -- --source=db                # dry run against the content DB (CONTENT_DATABASE_URL)
 *   npm run hypurr:sync -- --apply                    # create missing projects + fill empty fields (content DB, R2)
 *   npm run hypurr:sync -- --apply --max-creates=20 --no-rehost
 *
 * --apply never overwrites a non-empty field and never deletes anything. Run it with the
 * prod env injected (e.g. `railway run npm run hypurr:sync -- --apply`); secrets are never printed.
 */
import 'dotenv/config';
import fs from 'fs';
import { scrapeHypurrEcosystem } from '../src/services/project/hypurr-sync/hypurr.scraper';
import { matchProjects } from '../src/services/project/hypurr-sync/hypurr.matcher';
import { formatDiff } from '../src/services/project/hypurr-sync/hypurr-sync.report';
import {
  LT_PUBLIC_API,
  loadLtCategoryNamesFromApi,
  loadLtProjectsFromApi,
} from '../src/services/project/hypurr-sync/hypurr-sync.lt-source';
import { SyncDiff } from '../src/services/project/hypurr-sync/hypurr-sync.types';

function arg(name: string): string | undefined {
  const i = process.argv.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (i < 0) return undefined;
  const a = process.argv[i];
  if (a.includes('=')) return a.slice(a.indexOf('=') + 1);
  const next = process.argv[i + 1];
  return next && !next.startsWith('--') ? next : '';
}

/** host/dbname only, never credentials */
function describeTarget(url: string | undefined): string {
  if (!url) return '(unset)';
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}`;
  } catch {
    return '(unparseable url)';
  }
}

async function main(): Promise<void> {
  const apply = arg('apply') !== undefined;
  const source = apply ? 'db' : (arg('source') ?? 'api');
  const jsonOut = arg('json');
  const verbose = arg('verbose') !== undefined;
  const maxCreates = Number.parseInt(arg('max-creates') ?? '50', 10);
  const rehostLogos = arg('no-rehost') === undefined;
  const ltApi = arg('lt-api') || LT_PUBLIC_API;

  console.log(`Mode: ${apply ? 'APPLY' : 'dry run'} | LT source: ${source === 'db' ? `content DB ${describeTarget(process.env.CONTENT_DATABASE_URL)}` : ltApi}`);

  const scrape = await scrapeHypurrEcosystem();
  console.log(
    `Hypurr: ${scrape.projects.length} projects (listing ${scrape.listingPages} pages / ${scrape.listingCards} cards, ` +
      `data.json ${scrape.dataJsonRecords} records, ${scrape.detailFetches} detail pages)`
  );
  for (const w of scrape.warnings) console.log(`  [warn] ${w}`);

  let diff: SyncDiff;
  if (source === 'db') {
    // Imported lazily: the content DB client needs CONTENT_DATABASE_URL at load time.
    const { runDbSync } = await import('../src/services/project/hypurr-sync/hypurr-sync.apply');
    const run = await runDbSync(scrape.projects, {
      maxCreates: Number.isFinite(maxCreates) && maxCreates >= 0 ? maxCreates : 50,
      rehostLogos,
      dryRun: !apply,
    });
    diff = run.diff;
    console.log('\n' + formatDiff(diff, { verbose }));
    if (apply) {
      const r = run.result;
      console.log(
        `\nAPPLIED created=${r.created.length} filled=${r.filled.length} skipped=${r.createSkipped.length} ` +
          `failed=${r.failures.length} logos_on_R2=${r.logosOnR2} logos_fallback=${r.logosFallback}`
      );
      for (const c of r.created) console.log(`  [created] ${c}`);
      for (const f of r.filled) console.log(`  [filled] ${f.title}: ${f.fields.join(', ')}`);
      for (const s of r.createSkipped) console.log(`  [skipped] ${s.name}: ${s.reason}`);
      for (const f of r.failures) console.log(`  [FAIL] ${f.name}: ${f.error}`);
      if (r.categoriesCreated.length) console.log(`  New categories: ${r.categoriesCreated.join(', ')}`);
    }
  } else {
    const [lt, categoryNames] = await Promise.all([loadLtProjectsFromApi(ltApi), loadLtCategoryNamesFromApi(ltApi)]);
    diff = matchProjects(scrape.projects, lt, categoryNames);
    console.log('\n' + formatDiff(diff, { verbose }));
  }

  if (jsonOut) {
    fs.writeFileSync(jsonOut, JSON.stringify(diff, null, 2));
    console.log(`\nFull diff written to ${jsonOut}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('FATAL:', e instanceof Error ? e.message : e);
    process.exit(1);
  });
