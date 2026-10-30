#!/bin/bash
# Spike: cold start and memory of the per-user, per-space headless Chrome
# behind SilverBullet's Runtime API. Restarts the test instance's SilverBullet
# so that no runtime is running, then starts alice/alpha and bob/beta.
#
#   docker compose -f test/compose.yaml run --rm bootstrap
#   spike/measure-runtime.sh
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; . test/.state/env; set +a
C=sbmcp-test-silverbullet-1

mem() { # label
  local cg pss
  # Memory charged to the container (cgroup v2), the number that matters for sizing.
  cg=$(docker exec "$C" sh -c 'cat /sys/fs/cgroup/memory.current')
  # Proportional set size of all Chrome processes (shared pages split between them).
  pss=$(docker exec "$C" sh -c 'n=0; t=0; for p in $(pgrep chromium); do
      r=$(awk "/^Pss:/{print \$2}" /proc/$p/smaps_rollup 2>/dev/null) || continue
      [ -n "$r" ] && n=$((n+1)) && t=$((t+r)); done; echo "$n $((t/1024))"')
  printf '%-28s container %4d MiB   chrome: %s processes, PSS %s MiB\n' "$1" $((cg / 1048576)) ${pss% *} ${pss#* }
}

ms() { python3 -c 'import time; print(int(time.time()*1000))'; }

docker restart "$C" >/dev/null
until [ "$(curl -s -o /dev/null -w '%{http_code}' "$SB_URL/.dashboard/api/admin/spaces")" = 401 ]; do sleep 0.2; done
sleep 3
mem "baseline (no runtime)"

for run in ALICE:alpha BOB:beta; do
  user=${run%%:*} space=${run#*:}
  token_var=SB_TOKEN_$user
  t0=$(ms)
  code=$(curl -s -o /dev/null -w '%{http_code}' -H 'X-Timeout: 120' -H "Authorization: Bearer ${!token_var}" \
    --data '1' "$SB_URL/$space/.runtime/lua")
  echo "cold start $user/$space: HTTP $code in $(($(ms) - t0)) ms"
  t0=$(ms)
  curl -s -o /dev/null -H "Authorization: Bearer ${!token_var}" --data '1' "$SB_URL/$space/.runtime/lua"
  echo "warm call  $user/$space: $(($(ms) - t0)) ms"
  sleep 3
  mem "after $user/$space runtime"
done

t0=$(ms)
curl -s -o /dev/null -H "Authorization: Bearer $SB_TOKEN_ALICE" \
  --data-binary 'return markdown.expandMarkdown(space.readPage("Rendered"))' "$SB_URL/alpha/.runtime/lua_script"
echo "render Rendered (warm): $(($(ms) - t0)) ms"
t0=$(ms)
curl -s -o /dev/null -H "Authorization: Bearer $SB_TOKEN_ALICE" "$SB_URL/alpha/.runtime/screenshot"
echo "screenshot (warm): $(($(ms) - t0)) ms"
sleep 2
mem "after render + screenshot"
