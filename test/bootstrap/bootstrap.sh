#!/bin/bash
# Bootstraps the test instance through SilverBullet's admin API: runtime API on,
# users alice and bob, spaces alpha and beta with their grants, one API token per
# user, and the seed pages. Idempotent: a second run keeps what exists.
#
# Writes to /state (test/.state on the host):
#   <user>.token   the user's API token
#   env            SB_URL and the tokens as shell variables, for the spikes and tests
set -euo pipefail

: "${SB_URL:?}" "${SB_ADMIN_PASSWORD:?}"
STATE=/state
COOKIE=
USER_PASSWORD=${SB_USER_PASSWORD:-user-test-password}

# curl's cookie jar does not send cookies to a dotless host such as `silverbullet`,
# so the session cookie is passed by hand.
api() { # method path [json]
  local method=$1 path=$2 body=${3:-}
  local args=(-sS -X "$method" -H "Cookie: $COOKIE" -w '\n%{http_code}')
  [ -n "$body" ] && args+=(-H 'Content-Type: application/json' -d "$body")
  curl "${args[@]}" "$SB_URL/.dashboard/api$path"
}

expect() { # what accepted-codes response
  local what=$1 ok=$2 response=$3 code
  code=${response##*$'\n'}
  if [[ " $ok " != *" $code "* ]]; then
    echo "bootstrap: $what failed with $code: ${response%$'\n'*}" >&2
    exit 1
  fi
  echo "bootstrap: $what ($code)"
}

COOKIE=$(curl -sS -D - -o /dev/null -X POST -H 'Content-Type: application/json' \
  -d "{\"username\":\"admin\",\"password\":\"$SB_ADMIN_PASSWORD\"}" "$SB_URL/.dashboard/api/login" |
  sed -n 's/^set-cookie: \([^;]*\).*/\1/Ip' | head -n1)
[ -n "$COOKIE" ] || { echo "bootstrap: admin login failed" >&2; exit 1; }
echo "bootstrap: admin login"
expect "runtime API on" 200 "$(api PUT /admin/server-config '{"runtimeApi":true}')"

users=$(api GET /admin/users)
for user in alice bob; do
  if grep -q "\"$user\"" <<<"$users"; then
    echo "bootstrap: user $user exists"
  else
    expect "user $user" 200 "$(api POST /admin/users "{\"username\":\"$user\",\"password\":\"$USER_PASSWORD\"}")"
  fi
done

spaces=$(api GET /admin/spaces)
create_space() { # name members-json
  if grep -q "\"name\":\"$1\"" <<<"$spaces"; then
    echo "bootstrap: space $1 exists"
  else
    expect "space $1" 200 "$(api POST /admin/spaces "{\"name\":\"$1\",\"folder\":\"spaces/$1\",\"binding\":{\"prefix\":\"/$1\"},\"members\":$2}")"
  fi
}
create_space alpha '{"alice":{"role":"write","runtimeApi":true},"bob":{"role":"read"}}'
create_space beta '{"bob":{"role":"write","runtimeApi":true}}'

token_valid() { # user space
  [ -s "$STATE/$1.token" ] &&
    [ "$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $(cat "$STATE/$1.token")" "$SB_URL/$2/.fs/index.md")" = 200 ]
}
issue_token() { # user
  api DELETE "/admin/users/$1/tokens/test" >/dev/null
  local response
  response=$(api POST "/admin/users/$1/tokens" '{"name":"test"}')
  expect "token for $1" 200 "$response"
  sed -n 's/.*"token":"\([^"]*\)".*/\1/p' <<<"$response" | head -n1 >"$STATE/$1.token"
}
mkdir -p "$STATE"
for pair in admin:alpha alice:alpha bob:beta; do
  user=${pair%%:*}
  token_valid "$user" "${pair#*:}" || issue_token "$user"
done

# Seed pages: create-only (If-None-Match: *), so edits made by tests survive a re-run.
ADMIN_TOKEN=$(cat "$STATE/admin.token")
for dir in /bootstrap/seed/*/; do
  space=$(basename "$dir")
  (cd "$dir" && find . -type f -name '*.md') | sed 's|^\./||' | while read -r page; do
    code=$(curl -s -o /dev/null -w '%{http_code}' -X PUT -H "Authorization: Bearer $ADMIN_TOKEN" \
      -H 'If-None-Match: *' --data-binary "@$dir$page" "$SB_URL/$space/.fs/${page// /%20}")
    case $code in
      200 | 201 | 204) echo "bootstrap: seeded $space/$page" ;;
      412) ;;
      *) echo "bootstrap: seeding $space/$page failed with $code" >&2; exit 1 ;;
    esac
  done
done

cat >"$STATE/env" <<EOF
SB_URL=http://127.0.0.1:${SB_HOST_PORT:-3300}
SB_TOKEN_ADMIN=$ADMIN_TOKEN
SB_TOKEN_ALICE=$(cat "$STATE/alice.token")
SB_TOKEN_BOB=$(cat "$STATE/bob.token")
EOF
echo "bootstrap: done; tokens in test/.state/env"
