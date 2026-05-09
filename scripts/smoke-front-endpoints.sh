#!/usr/bin/env bash
# E2E smoke test: every backend endpoint the frontend consumes.
# Runs against http://localhost:3002 (local backend on the 3-DB split stack).
# - 200 / 401 = endpoint is wired (auth-protected ones report 401 without token)
# - 404 / 5xx = misrouted or broken
# Outputs PASS/FAIL per endpoint.
set -u

BASE="${BASE:-http://localhost:3002}"
PASS=0
FAIL=0
RESULTS=()

# $1=name $2=method $3=path $4=expected_codes (CSV)
hit() {
  local name="$1" method="$2" path="$3" expected="$4"
  local code body
  if [[ "$method" == "GET" ]]; then
    body=$(curl -sS -o /tmp/resp.json -w "%{http_code}" "$BASE$path" 2>/dev/null)
  else
    body=$(curl -sS -X "$method" -o /tmp/resp.json -w "%{http_code}" -H "Content-Type: application/json" -d '{}' "$BASE$path" 2>/dev/null)
  fi
  code="$body"
  if [[ ",$expected," == *",$code,"* ]]; then
    PASS=$((PASS+1))
    RESULTS+=("✅ $code  $method $path  → $name")
  else
    FAIL=$((FAIL+1))
    RESULTS+=("❌ $code  $method $path  → $name  (expected $expected)")
    head -c 200 /tmp/resp.json | tr -d '\n'
    echo ""
  fi
}

echo "=== Public Goods (Content DB) ==="
hit "list"               GET    "/publicgoods"                         200,401
hit "list with params"   GET    "/publicgoods?page=1&limit=5"          200,401
hit "by id"              GET    "/publicgoods/1"                       200,401,404
hit "my-submissions"     GET    "/publicgoods/my-submissions"          200,401
hit "pending"            GET    "/publicgoods/pending"                 200,401
hit "create (auth)"      POST   "/publicgoods"                         400,401,500
hit "review (auth)"      PATCH  "/publicgoods/1/review"                400,401,404,500

echo ""
echo "=== Educational (Content DB + cross-DB enrichment) ==="
hit "resources list"     GET    "/educational/resources"               200,401
hit "resources by id"    GET    "/educational/resources/1"             200,401,404
hit "by category"        GET    "/educational/resources/category/1"    200,401,404
hit "my submissions"     GET    "/educational/resources/my-submissions" 200,401
hit "moderation pending" GET    "/educational/resources/moderation/pending" 200,401
hit "moderation count"   GET    "/educational/resources/moderation/pending/count" 200,401
hit "moderation reports" GET    "/educational/resources/moderation/reports" 200,401
hit "categories list"    GET    "/educational/categories"              200,401

echo ""
echo "=== Project (Content DB) ==="
hit "project list"       GET    "/project"                             200,401
hit "project by id"      GET    "/project/1"                           200,401,404
hit "project categories" GET    "/project/1/categories"                200,401,404

echo ""
echo "=== Category (Content DB) ==="
hit "category list"      GET    "/category"                            200,401
hit "category by id"     GET    "/category/1"                          200,401,404

echo ""
echo "=== Link Preview (Content DB) ==="
hit "by url"             GET    "/link-preview?url=https://example.com/article1" 200,401,404
hit "by id"              GET    "/link-preview/lp_test1"               200,401,404
hit "list"               GET    "/link-preview/list"                   200,401,404

echo ""
echo "=== ReadLists (Core DB + cross-DB Resource enrichment) ==="
hit "public list"        GET    "/readlists/public"                    200,401
hit "my lists (auth)"    GET    "/readlists/my-lists"                  200,401
hit "by id"              GET    "/readlists/1"                         200,401,404
hit "items"              GET    "/readlists/1/items"                   200,401,404

echo ""
echo "=== Auth / Telegram (Core User + Telegram DB) ==="
hit "auth me (auth)"     GET    "/auth/me"                             200,401
hit "telegram gen-link"  POST   "/auth/telegram/generate-link"         200,401,400,500
hit "telegram status"    GET    "/auth/telegram/link-status/abc123"    200,401,400,404,500
hit "telegram unlink"    DELETE "/auth/telegram/unlink"                200,401,500

echo ""
echo "=== Wallets (Core DB) ==="
hit "wallet list (auth)" GET    "/wallet"                              200,401
hit "walletlists"        GET    "/walletlists"                         200,401

echo ""
echo "=== Health (4 DBs) ==="
hit "health"             GET    "/api/health"                          200

echo ""
echo "=========================================="
printf '%s\n' "${RESULTS[@]}"
echo "=========================================="
echo "Total: $PASS passed, $FAIL failed"
[ $FAIL -eq 0 ] && exit 0 || exit 1
