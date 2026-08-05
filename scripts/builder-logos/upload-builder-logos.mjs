/**
 * Uploads the curated builder logos to R2 under `builders/logos/`.
 *
 * Input : a directory of files named `<builderAddress>.<png|svg>` (see
 *         `fetch-builder-logos.py`, which sources them from each brand's own site).
 * Output: `builder-logos.manifest.json` — address -> public R2 URL, ready to be
 *         folded into the frontend registry (`src/lib/builderBrands.ts`).
 *
 * Keys carry a content hash so a refreshed logo gets a new immutable URL rather
 * than fighting the 1-year CDN cache.
 *
 * Usage: node scripts/builder-logos/upload-builder-logos.mjs <logosDir> [manifestOut]
 */
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import 'dotenv/config';

const FOLDER = 'builders/logos';
const MIME = { '.png': 'image/png', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.webp': 'image/webp' };

const {
  R2_ACCOUNT_ID: accountId,
  R2_ACCESS_KEY_ID: accessKeyId,
  R2_SECRET_ACCESS_KEY: secretAccessKey,
  R2_BUCKET_NAME: bucket,
  R2_PUBLIC_URL: publicUrl,
} = process.env;

if (!accountId || !accessKeyId || !secretAccessKey || !bucket || !publicUrl) {
  console.error('Missing R2_* env vars (expected in .env)');
  process.exit(1);
}

const s3 = new S3Client({
  region: 'auto',
  endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId, secretAccessKey },
});

const dir = process.argv[2];
const manifestOut = process.argv[3] ?? path.join(dir, 'builder-logos.manifest.json');
if (!dir) {
  console.error('Usage: node upload-builder-logos.mjs <logosDir> [manifestOut]');
  process.exit(1);
}

const files = (await readdir(dir)).filter((f) => /^0x[0-9a-f]{40}\.(png|svg|jpg|webp)$/i.test(f));
const manifest = {};

for (const file of files) {
  const ext = path.extname(file).toLowerCase();
  const address = path.basename(file, ext).toLowerCase();
  const body = await readFile(path.join(dir, file));
  const hash = createHash('sha256').update(body).digest('hex').slice(0, 8);
  const key = `${FOLDER}/${address}-${hash}${ext}`;

  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: MIME[ext] ?? 'application/octet-stream',
      CacheControl: 'public, max-age=31536000, immutable',
    })
  );

  manifest[address] = `${publicUrl.replace(/\/+$/, '')}/${key}`;
  console.log(`✓ ${address} → ${key} (${body.length}b)`);
}

await writeFile(manifestOut, JSON.stringify(manifest, null, 2));
console.log(`\n${files.length} logos uploaded. Manifest: ${manifestOut}`);
