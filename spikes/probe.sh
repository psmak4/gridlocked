#!/usr/bin/env bash
# Spike (Task 6): probes one deployed host. curl only. Usage:
#   spikes/probe.sh https://<host>
# Prints timings and headers. Cookie values are redacted; the cookie jar
# lives in a temp dir that is deleted on exit. Run it after the host has
# been idle 15 minutes to make the first request a cold start.
set -euo pipefail
BASE="${1:?usage: probe.sh <base-url>}"
BASE="${BASE%/}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
JAR="$TMP/jar"
HDRS="age|cache-status|x-vercel-cache|cf-cache-status|x-nf-request-id|cache-control|vary|server"

ttfb() { curl -s -o /dev/null -w '%{time_starttransfer}' "$@"; }
pct() { sort -n | awk -v p="$1" '{a[NR]=$1} END {i=int(p/100*NR); if (i<1) i=1; if (i>NR) i=NR; printf "%.0f ms", a[i]*1000}'; }
show_headers() { grep -iE "^($HDRS):" "$1" | tr -d '\r' | sed 's/^/    /' || true; }
redact_cookies() {
  grep -i '^set-cookie:' "$1" | tr -d '\r' \
    | sed -E 's/^([Ss]et-[Cc]ookie: *[^=]+)=[^;]*/\1=<redacted>/' | sed 's/^/    /' || true
}

echo "== $BASE"
echo "-- first request (cold if idle >= 15 min): / $(ttfb "$BASE/" | awk '{printf "%.0f ms", $1*1000}')"

for _ in 1 2 3; do ttfb "$BASE/results/18" >/dev/null; done
for _ in $(seq 20); do ttfb "$BASE/results/18"; echo; done > "$TMP/warm"
echo "-- /results/18 warm x20 TTFB: p50 $(pct 50 < "$TMP/warm") p95 $(pct 95 < "$TMP/warm")"

curl -s -o /dev/null -D "$TMP/h1" "$BASE/results/18"
curl -s -o /dev/null -D "$TMP/h2" "$BASE/results/18"
echo "-- /results/18 second request headers:"; show_headers "$TMP/h2"

W="probe-$RANDOM$RANDOM"
start=$(date +%s)
for _ in $(seq 30); do
  curl -s -o /dev/null -D "$TMP/hc" "$BASE/api/threads/1/latest?w=$W"
done
end=$(date +%s)
echo "-- chat window w=$W: 30 requests in $((end - start)) s; last response headers:"; show_headers "$TMP/hc"
echo "   then: select count(*) from spike_hits where path like '%w=$W'   (expected 1)"

EMAIL="probe-$RANDOM$RANDOM@example.test"
BODY="{\"email\":\"$EMAIL\",\"password\":\"spike-password-1\",\"name\":\"probe\"}"
code=$(curl -s -o /dev/null -D "$TMP/su" -w '%{http_code} %{time_total}' -c "$JAR" \
  -H 'content-type: application/json' -H "origin: $BASE" -d "$BODY" "$BASE/api/auth/sign-up/email")
echo "-- sign-up: $code"; redact_cookies "$TMP/su"; show_headers "$TMP/su"
rm -f "$JAR"
code=$(curl -s -o /dev/null -D "$TMP/si" -w '%{http_code} %{time_total}' -c "$JAR" \
  -H 'content-type: application/json' -H "origin: $BASE" -d "$BODY" "$BASE/api/auth/sign-in/email")
echo "-- sign-in: $code"; redact_cookies "$TMP/si"; show_headers "$TMP/si"

code=$(curl -s -o /dev/null -D "$TMP/me" -w '%{http_code}' -b "$JAR" "$BASE/me")
echo "-- /me signed in: $code"; show_headers "$TMP/me"
code=$(curl -s -o /dev/null -D "$TMP/meo" -w '%{http_code} -> %{redirect_url}' "$BASE/me")
echo "-- /me signed out: $code"; show_headers "$TMP/meo"
for _ in 1 2; do curl -s -o /dev/null -D "$TMP/rc" -b "$JAR" "$BASE/results/18"; done
echo "-- /results/18 with a session cookie (second request):"; show_headers "$TMP/rc"; redact_cookies "$TMP/rc"
echo "-- pick flow: SPIKE_E2E=1 SPIKE_BASE_URL=$BASE pnpm exec playwright test e2e/spike"
