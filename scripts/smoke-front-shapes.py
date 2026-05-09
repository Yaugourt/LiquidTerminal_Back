#!/usr/bin/env python3
"""Verify each public endpoint returns the exact JSON shape the frontend expects."""
import json
import sys
import urllib.request

BASE = "http://localhost:3002"
PASS = 0
FAIL = 0


def get(path: str) -> dict:
    with urllib.request.urlopen(f"{BASE}{path}") as r:
        return json.loads(r.read())


def check(name: str, ok: bool) -> None:
    global PASS, FAIL
    if ok:
        print(f"✅ {name}")
        PASS += 1
    else:
        print(f"❌ {name}")
        FAIL += 1


print("=== /publicgoods → submittedBy {id,name,email}, reviewedBy {id,name,email}|null ===")
r = get("/publicgoods")
check("data is array", isinstance(r.get("data"), list))
if r.get("data"):
    pg = r["data"][0]
    sb = pg.get("submittedBy") or {}
    check("submittedBy.id is number", isinstance(sb.get("id"), int))
    check("submittedBy.name present (key exists)", "name" in sb)
    check("submittedBy.email present (key exists)", "email" in sb)
    rb = pg.get("reviewedBy")
    check("reviewedBy is object or null", rb is None or (isinstance(rb, dict) and isinstance(rb.get("id"), int) and "name" in rb and "email" in rb))
check("pagination.total is number", isinstance(r.get("pagination", {}).get("total"), int))

print("\n=== /educational/resources → creator (full), reviewer (no email), categories[].assigner ===")
r = get("/educational/resources")
check("data is array", isinstance(r.get("data"), list))
if r.get("data"):
    er = r["data"][0]
    cr = er.get("creator") or {}
    check("creator.id is number", isinstance(cr.get("id"), int))
    check("creator.name key present", "name" in cr)
    check("creator.email key present", "email" in cr)
    rev = er.get("reviewer")
    check("reviewer null OR (id+name)", rev is None or (isinstance(rev.get("id"), int) and "name" in rev))
    check("reviewer has NO email key (front contract)", rev is None or "email" not in rev)
    cats = er.get("categories")
    check("categories is array", isinstance(cats, list))
    if cats:
        cat = cats[0]
        sub = cat.get("category") or {}
        check("category.{id,name,description}", isinstance(sub.get("id"), int) and "name" in sub and "description" in sub)
        asg = cat.get("assigner")
        check("assigner null OR (id+name, no email)", asg is None or (isinstance(asg.get("id"), int) and "name" in asg and "email" not in asg))

print("\n=== /educational/categories → creator {id,name,email} ===")
r = get("/educational/categories")
if r.get("data"):
    cr = r["data"][0].get("creator") or {}
    check("creator full {id,name,email}", isinstance(cr.get("id"), int) and "name" in cr and "email" in cr)

print("\n=== /readlists/1 → deep chain items[].resource.creator ===")
r = get("/readlists/1")
data = r.get("data") if isinstance(r, dict) else r
if isinstance(data, dict):
    cr = data.get("creator") or {}
    check("creator full {id,name,email}", isinstance(cr.get("id"), int) and "name" in cr and "email" in cr)
    items = data.get("items") or []
    check("items is array", isinstance(items, list) and len(items) > 0)
    if items:
        it = items[0]
        res = it.get("resource") or {}
        check("item.resource exists with id/url/createdAt/creator", all(k in res for k in ("id", "url", "createdAt", "creator")))
        rc = res.get("creator") or {}
        check("resource.creator full {id,name,email}", isinstance(rc.get("id"), int) and "name" in rc and "email" in rc)

print("\n=== /readlists/public → summary with creator + itemsCount ===")
r = get("/readlists/public")
if r.get("data"):
    pl = r["data"][0]
    check("creator + itemsCount", "creator" in pl and isinstance(pl.get("itemsCount"), int))

print("\n=== /project → categories embedded, no User ===")
r = get("/project")
if r.get("data"):
    p = r["data"][0]
    check("categories is array", isinstance(p.get("categories"), list))
    check("no creator key (Project doesn't include User)", "creator" not in p)

print("\n=== /category/1 ===")
r = get("/category/1")
data = r.get("data") if isinstance(r, dict) else r
check("category id", isinstance((data or {}).get("id"), int))

print("\n=== /link-preview?url=... ===")
r = get("/link-preview?url=https://example.com/article1")
if r.get("data"):
    lp = r["data"][0] if isinstance(r["data"], list) else r["data"]
    check("linkPreview shape (id+url+title)", all(k in lp for k in ("id", "url", "title")))

print("\n=== /api/health → 4 DBs up ===")
r = get("/api/health")
ck = r.get("checks", {})
check("core db up", ck.get("database", {}).get("status") == "up")
check("content db up", ck.get("contentDatabase", {}).get("status") == "up")
check("telegram db up", ck.get("telegramDatabase", {}).get("status") == "up")
check("historical db up", ck.get("historicalDatabase", {}).get("status") == "up")

print("\n" + "=" * 50)
print(f"Total: {PASS} passed, {FAIL} failed")
sys.exit(0 if FAIL == 0 else 1)
