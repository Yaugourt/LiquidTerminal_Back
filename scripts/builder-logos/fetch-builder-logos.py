"""
Resolve one square logo per Hyperliquid builder address.

Two sources, in order of trust:
  1. the LiquidTerminal ecosystem DB (logo already on our R2) — reused as-is;
  2. the brand's own website (apple-touch-icon > <link rel=icon> > og:image),
     downloaded, squared and resized to 128px.

Nothing is hotlinked from a third-party dashboard: only first-party brand assets.
"""
import json, re, io, os, sys, urllib.request, urllib.parse
import concurrent.futures as cf
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "logos")
os.makedirs(OUT, exist_ok=True)

UA = {"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36",
      "Accept": "text/html,image/*,*/*"}
SIZE = 128


def http(url, timeout=15, max_bytes=4_000_000):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read(max_bytes), r.geturl(), r.headers.get("Content-Type", "")


def icon_candidates(domain):
    """Ordered icon URLs advertised by a site, best (square, big) first."""
    for base in (f"https://{domain}", f"https://www.{domain}"):
        try:
            body, final, _ = http(base)
        except Exception:
            continue
        html = body.decode("utf-8", "ignore")
        scored = []
        for tag in re.findall(r"<link[^>]+>", html, re.I):
            if not re.search(r'rel=["\'][^"\']*icon', tag, re.I):
                continue
            m = re.search(r'href=["\']([^"\']+)', tag)
            if not m:
                continue
            href = urllib.parse.urljoin(final, m.group(1))
            sizes = re.search(r'sizes=["\'](\d+)', tag)
            px = int(sizes.group(1)) if sizes else 0
            apple = 1 if re.search(r"apple-touch-icon", tag, re.I) else 0
            svg = 1 if href.lower().endswith(".svg") else 0
            # prefer apple-touch-icon, then the biggest declared raster size
            scored.append((-apple, -px, svg, href))
        scored.sort()
        out = [h for *_, h in scored]
        og = re.search(r'<meta[^>]+property=["\']og:image["\'][^>]+content=["\']([^"\']+)', html, re.I)
        if og:
            out.append(urllib.parse.urljoin(final, og.group(1)))
        out += [urllib.parse.urljoin(final, "/apple-touch-icon.png"),
                urllib.parse.urljoin(final, "/favicon.ico")]
        return out
    return [f"https://{domain}/apple-touch-icon.png", f"https://{domain}/favicon.ico"]


def square(img):
    """Trim to the largest centred square, then resize. Keeps alpha."""
    img = img.convert("RGBA")
    w, h = img.size
    if w != h:
        s = min(w, h)
        img = img.crop(((w - s) // 2, (h - s) // 2, (w - s) // 2 + s, (h - s) // 2 + s))
    return img.resize((SIZE, SIZE), Image.LANCZOS)


def download(url):
    body, _, ct = http(url)
    if url.lower().endswith(".svg") or "svg" in ct:
        return ("svg", body)
    img = Image.open(io.BytesIO(body))
    # ICO / multi-frame: take the biggest frame
    if getattr(img, "n_frames", 1) > 1 and img.format == "ICO":
        best, area = img, 0
        for f in range(img.n_frames):
            img.seek(f)
            if img.size[0] * img.size[1] > area:
                area = img.size[0] * img.size[1]
                best = img.copy()
        img = best
    if min(img.size) < 32:
        raise ValueError(f"icon too small {img.size}")
    buf = io.BytesIO()
    square(img).save(buf, "PNG", optimize=True)
    return ("png", buf.getvalue())


def resolve(entry):
    addr, brand, domain = entry["address"], entry["brand"], entry.get("domain")
    if not domain:
        return {**entry, "status": "no-source"}
    errs = []
    for url in icon_candidates(domain)[:8]:
        try:
            kind, data = download(url)
        except Exception as e:
            errs.append(f"{url.split('/')[-1]}: {type(e).__name__}")
            continue
        path = os.path.join(OUT, f"{addr}.{kind}")
        with open(path, "wb") as f:
            f.write(data)
        return {**entry, "status": "ok", "file": path, "from": url, "bytes": len(data)}
    return {**entry, "status": "failed", "errors": errs[:4]}


if __name__ == "__main__":
    todo = json.load(open(sys.argv[1]))
    with cf.ThreadPoolExecutor(10) as ex:
        res = list(ex.map(resolve, todo))
    json.dump(res, open(sys.argv[2], "w"), indent=1)
    ok = [r for r in res if r["status"] == "ok"]
    print(f"{len(ok)}/{len(res)} logos downloaded")
    for r in res:
        if r["status"] != "ok":
            print(f"  MISS {r['brand']:<18} {r.get('domain')} {r.get('errors', r['status'])}")
