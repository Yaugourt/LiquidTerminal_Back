# Builder logos

Seeds the logos shown next to each Hyperliquid builder on
`liquidterminal.xyz/market/builders`.

The indexer only returns the builder code a team registered on-chain (`PURPS`,
`MMCSI`, `1KREF`…). The front pairs that code with a curated brand + logo via
`liquidterminal_front/src/lib/builderBrands.ts`; this folder produces the assets
that registry points at.

## Where a logo comes from

1. **The ecosystem directory** — if the brand is already a `Project` row, reuse
   its `logo` (already on our R2, already curated). Nothing to do here.
2. **The brand's own site** — `fetch-builder-logos.py` reads the site's
   `apple-touch-icon` / declared `<link rel=icon>` / `og:image`, keeps the
   largest square candidate, crops it centred and resizes to 128px PNG.

Never a third-party dashboard's asset bundle, and never a guessed handle: a
builder whose identity we cannot corroborate is left out of the registry and
keeps the generated initial avatar. A wrong logo is worse than no logo.

## Run

```bash
# 1. build the work list: [{ "address": "0x…", "brand": "Rabby", "domain": "rabby.io" }, …]
#    `brand-domains.json` holds the brand -> domain pairs verified so far.
python3 scripts/builder-logos/fetch-builder-logos.py todo.json result.json
#    -> writes ./logos/<address>.png (or .svg when the site only ships SVG)

# 2. push to R2 and emit address -> public URL
node scripts/builder-logos/upload-builder-logos.mjs ./logos
#    -> logos/builder-logos.manifest.json
```

Requires `Pillow` for step 1 and the `R2_*` vars from `.env` for step 2.

## Adding a builder

Resolve its domain, add it to `brand-domains.json`, run both steps, then add one
line to `builderBrands.ts` in the frontend with the manifest URL (minus the
bucket prefix). Keys carry a content hash, so a refreshed logo lands on a new
immutable URL instead of fighting the 1-year CDN cache — objects that no longer
appear in the registry are simply inert.
