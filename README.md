# silverbullet-mcp

An MCP server for a [SilverBullet](https://silverbullet.md) instance in multi-space mode: several agents, each acting as its own SilverBullet user, every space that user may reach, and pages rendered the way SilverBullet shows them.

## Goals

One MCP server for a whole SilverBullet instance that, beyond reading and writing pages:

1. serves **several agents**, each with its own credential and its own SilverBullet user, and acts towards SilverBullet as *that* user, so that SilverBullet's permissions decide what is allowed and every write stays attributable to a user;
2. reaches **every space** of the instance that the agent's user may access (SilverBullet ≥ 2.10 multi-space mode, spaces addressed as `/<space>`);
3. returns a page **rendered**, as Markdown with `${…}` expressions, queries, templates and transclusions evaluated, and as a **screenshot** (PNG), next to the raw source;
4. keeps the **revision-guarded `edit-note`** with `dryRun`, so that clients written for v1 keep working;
5. runs behind a reverse proxy with **secrets from files**, and verifies **OAuth tokens** of an external identity provider, or the assertions of **Cloudflare Access** in front of it, beside static bearers;
6. **restricts each agent further than SilverBullet does**, by path, with a deny-by-default access list per user and group that never widens what SilverBullet grants and applies to every tool, listings and search included;
7. **keeps code out of the pages agents write**, so that a page an agent wrote can be opened and rendered by any person without running anything but audited code;
8. is **MIT**, with code taken only from MIT, Apache or BSD sources.

It replaces a set-up of one single-user MCP server per user per space, called v1 in these documents ([Ahmad-A0/silverbullet-mcp](https://github.com/Ahmad-A0/silverbullet-mcp), one instance per identity): there, every additional identity costs one more container, and pages come back only as raw source, so queries do not show their results. How the server meets the goals is in [docs/architecture.md](docs/architecture.md).

## The security challenge

SilverBullet runs code from content: every Space Lua block and every `${…}` expression on any page runs in the browser of the person who opens the page, with that person's rights. An agent that can write one page can plant code that reads or writes everything, and a path-based access list does not close this: it decides where an agent may write, not what the written page may do. The server therefore keeps code out of the pages agents write and confines it to `Library/`, with configuration in `CONFIG`; the full model, and the terms *user*, *person*, *agent* and *operator* as these documents use them, are in [docs/security.md](docs/security.md).

## Posture

The server ships strict: a deny-by-default access list, a write filter on every write with an allowlist of the functions a page may call, a scan of the space in report-only mode, an index-time transform in `CONFIG` that keeps blocks outside `CONFIG` and `Library/` from loading, a refusal to serve while any of these is missing, and no rendering in a space where the scan has findings. Every part but the last two can be relaxed (write access to `Library/`, more allowlist entries, more file types, scan off or in quarantine mode), and the server reports a relaxed setting once at start, in its log and on its report page in the space ([docs/security.md](docs/security.md), section 11). The rules, the defaults that enforce them, and what relaxing each one accepts are in [docs/space-guidelines.md](docs/space-guidelines.md); how the controls work is in [docs/security.md](docs/security.md).

## Status

**Core server and rendering, phases 1a and 1b.** The server in `src/` serves the ten tools below as the authenticated user, with the credentials file, the access list, the write filter, the scan with its report page, the refusal to serve, and the two render tools over SilverBullet's Runtime API. Phase 1c adds the deployment material: the client guide and the acceptance test below. Phase 2 adds OAuth: the server verifies access tokens of an external identity provider as a resource server ([docs/oauth.md](docs/oauth.md)); built and tested against a test issuer, not yet run against a real identity provider. Beside it, the server accepts requests that came through Cloudflare Access, by verifying the assertion Access adds ([docs/cloudflare-access.md](docs/cloudflare-access.md)); built and tested against a test team domain. The architecture and the security model are in `docs/`; the *release checks* in `test/` assert, per SilverBullet release, the behaviour the design relies on.

## What is here

| Path | What |
|---|---|
| [`docs/architecture.md`](docs/architecture.md) | Architecture decision for v2, with the measurements of the Runtime API spike |
| [`docs/oauth.md`](docs/oauth.md) | OAuth: what the server verifies, what the identity provider must do (with Keycloak), client registration, reachability, connecting a client |
| [`docs/cloudflare-access.md`](docs/cloudflare-access.md) | Cloudflare Access in front of the server: what the server verifies, what the Access application must do, the route, connecting a client |
| [`docs/security.md`](docs/security.md) | Security model: threat model, access list, write filter, allowlist, scan, index-time transform, defaults |
| [`docs/space-guidelines.md`](docs/space-guidelines.md) | Conventions a space follows when this server guards it |
| [`docs/facts/`](docs/facts) | Measured behaviour of SilverBullet 2.12.1 that the security model rests on |
| [`src/`](src) | The server: `main.ts` (entry, `--scan`, `--hash`), `server.ts` (HTTP, auth), `oauth.ts` and `cf-access.ts` (the two verifiers), `tools.ts` (the tools), `filter/` (the write filter on the vendored parser, the allowlist), `access.ts`, `credentials.ts`, `scan.ts`, `render.ts` (the render path over the Runtime API), `edit.ts`; unit tests beside the code |
| [`config/`](config) | The shipped allowlist and examples of the credentials file, the access list and the allowed-files list |
| [`test/`](test) | The release checks (a compose test instance, a bootstrap through the admin API, one check per assumption, a report per SilverBullet version) and, in `test/server/`, the server's integration tests against the same instance |
| [`scripts/acceptance.ts`](scripts/acceptance.ts) | The acceptance test of a running server, from any machine that reaches it (*Acceptance test* below) |
| [`Dockerfile`](Dockerfile), [`compose.example.yaml`](compose.example.yaml) | The image (`node:24-alpine`, non-root) and how to run it next to SilverBullet with secrets from files |
| [`.github/workflows/ci.yml`](.github/workflows/ci.yml) | Lint, unit and integration tests on every pull request; the image to `ghcr.io/finestream/silverbullet-mcp` on a version tag |

## Run

Needs Node.js 24 or newer (it runs the `.ts` files directly) and a SilverBullet instance in multi-space mode, 2.12 or newer.

```sh
npm install
MCP_CREDENTIALS_FILE=./secrets/credentials MCP_CONFIG_DIR=./config SB_URL=http://127.0.0.1:3000 node src/main.ts
```

The server listens on `PORT` (default 4000): `POST /mcp` is the MCP endpoint (streamable HTTP, stateless, bearer in the `Authorization` header), `GET /healthz` the health check, and, with OAuth configured, `GET /.well-known/oauth-protected-resource` its metadata. Clients that speak only stdio reach it through [`mcp-remote`](https://www.npmjs.com/package/mcp-remote) with the bearer as a header. The image does the same: see [compose.example.yaml](compose.example.yaml).

Two more modes: `node src/main.ts --scan` runs one scan over the guarded spaces and exits with 1 on findings (the installation step of [docs/security.md](docs/security.md), section 7); `printf '%s' "$SECRET" | node src/main.ts --hash` prints the SHA-256 of a client secret for the credentials file.

## Clients

The server speaks MCP over streamable HTTP: `POST https://<host>/mcp` with the client's bearer in the `Authorization` header. A client that speaks HTTP itself needs no helper:

```sh
claude mcp add --scope user --transport http notes https://mcp.example.org/mcp --header "Authorization: Bearer $BEARER"   # Claude Code
```

A client that speaks only stdio, such as the Claude desktop app, reaches it through [`mcp-remote`](https://www.npmjs.com/package/mcp-remote). The bearer goes into an environment variable, because the app does not pass arguments with spaces reliably:

```json
{
  "mcpServers": {
    "notes": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://mcp.example.org/mcp", "--header", "Authorization:${AUTH_HEADER}", "--transport", "http-only"],
      "env": { "AUTH_HEADER": "Bearer <the client's bearer>" }
    }
  }
}
```

One bearer per client (`printf '%s' "$BEARER" | node src/main.ts --hash` gives the hash for the credentials file); a scheduled or unattended run uses the connector of the app it runs in, with that connector's bearer. A client never holds a SilverBullet API token.

**With OAuth** (`MCP_OAUTH_ISSUER` and `MCP_OAUTH_RESOURCE` set) a client connects by URL and the user logs in at the identity provider; no bearer is handed around and no `mcp-remote` is needed:

```sh
claude mcp add --scope user --transport http notes https://mcp.example.org/mcp --client-id <client id> --callback-port 8765   # Claude Code; then /mcp, Authenticate
```

In Claude on the web, desktop and mobile: *Settings → Connectors → Add custom connector*, with the server's URL. Which client ID to enter, which redirect URIs the identity provider must allow, and from where each client must reach the server are in [docs/oauth.md](docs/oauth.md), sections 3 to 5. Static bearers keep working beside it.

**Through Cloudflare Access** (`MCP_CF_ACCESS_TEAM_DOMAIN` and `MCP_CF_ACCESS_AUD` set) a hosted client connects by the public URL and the user logs in at Access, which is then the only thing reachable from the internet; the user's line in the credentials file names the e-mail address Access signs in ([docs/cloudflare-access.md](docs/cloudflare-access.md)). The other ways in keep working beside it, by a route that does not pass Access.

## Acceptance test

`scripts/acceptance.ts` checks a running server from any machine that reaches it, as one user, and prints `PASS` or `FAIL` per check: a wrong bearer is refused with 401 and `/healthz` answers; `list-spaces` shows the spaces with the effective rights; a denied page is absent from listings and search and refused on read by the access list; a page is read raw with its revision; `render-note` and `screenshot-note` are either evaluated (a PNG) or refused by the access list, as `MCP_EXPECT_RENDER` says; a write outside the user's area is refused by the access list; a page with a `space-lua` block inside it is refused by the write filter with rule and line; a stale `edit-note` is rejected and the current revision accepted; the report page shows *serving*, a scan and no findings. It writes one page under `MCP_WRITE_AREA` and deletes it again where the user may.

```sh
npm ci
MCP_URL=https://mcp.example.org/mcp MCP_BEARER=… MCP_RAW_PAGE="A page with queries" MCP_SCREENSHOT_PAGE=index \
  MCP_WRITE_AREA="Shared/Bot/" MCP_DENIED_PAGE=CONFIG MCP_DENIED_TEXT="config.set" MCP_EXPECT_RENDER=no node scripts/acceptance.ts
```

`MCP_SPACE` selects a space other than the user's default; `MCP_OUTSIDE_PAGE` (default `Acceptance outside`) names a page the user may not create; `MCP_REPORT_PAGE` defaults to `MCP Server`. Exit code 0 when every check passed, 1 otherwise, 2 when the test could not run.

## Configuration

Three files and a few variables. The files are re-read when they change; a `SIGHUP` re-reads them and runs a scan.

| File | Variable | What |
|---|---|---|
| credentials (a secret) | `MCP_CREDENTIALS_FILE`, default `/run/secrets/credentials` | One line per SilverBullet user: API token, default space, groups, bearer hashes and, optionally, the e-mail addresses for Cloudflare Access; the line of the technical user (`MCP_SCAN_USER`, default `scan`) ([example](config/credentials.example); [docs/security.md](docs/security.md), section 3) |
| access list | `MCP_ACCESS_LIST_FILE`, default `$MCP_CONFIG_DIR/access-list` | What each user or group may do per space and path ([example](config/access-list.example); [docs/security.md](docs/security.md), section 4) |
| allowlist | `MCP_ALLOWLIST_FILE`, default `$MCP_CONFIG_DIR/allowlist` | The functions a page may call ([shipped default](config/allowlist); [docs/security.md](docs/security.md), section 6) |
| allowed files | `MCP_ALLOWED_FILES_FILE`, default `$MCP_CONFIG_DIR/allowed-files`, optional | Non-page files the scan may ignore ([example](config/allowed-files.example); [docs/security.md](docs/security.md), section 7) |

| Variable | Default | What |
|---|---|---|
| `SB_URL` | `http://silverbullet:3000` | The SilverBullet instance; spaces are addressed as `/<space>` below it |
| `PORT` | `4000` | The listening port |
| `MCP_CONFIG_DIR` | `/etc/silverbullet-mcp` | Where the access list, the allowlist and the allowed-files list are, unless given one by one |
| `MCP_SPACES` | all the scan user can see | The spaces to guard, comma-separated |
| `MCP_SCAN_USER` | `scan` | The technical user of the scan ([docs/security.md](docs/security.md), section 7): the credentials-file line that holds its token |
| `MCP_FILE_TYPES` | `.md` | The file types the server writes ([docs/security.md](docs/security.md), section 5) |
| `MCP_SCAN_INTERVAL` | `15m` | Time between scans (`0`: at start and on `SIGHUP` only) |
| `MCP_SCAN_MODE` | `report` | `report` or `quarantine` ([docs/security.md](docs/security.md), section 7) |
| `MCP_REPORT_PAGE` | `MCP Server` | The report page, written at the top level of every guarded space ([docs/security.md](docs/security.md), section 8) |
| `MCP_RATE_LIMIT` | `120` | Tool calls per user and minute; `0` for none |
| `MCP_RENDER_PARALLEL` | `4` | Runtime API calls in flight at once, over all users and spaces (*Rendering* below) |
| `MCP_RENDER_TIMEOUT` | `90s` | The most a `render-note` or `screenshot-note` call may take, queue and index wait included |
| `MCP_INDEX_WAIT` | `5s` | How long a render waits for the runtime's index to hold a page written through the server before it reboots the runtime ([docs/security.md](docs/security.md), section 12) |
| `MCP_LOG_LEVEL` | `info` | `info` or `debug`; the log is JSON lines on stdout |
| `MCP_OAUTH_ISSUER`, `MCP_OAUTH_RESOURCE` | none | Both set: the server verifies OAuth access tokens of that issuer for that resource URL, beside static bearers ([docs/oauth.md](docs/oauth.md)) |
| `MCP_OAUTH_JWKS_URL`, `MCP_OAUTH_USER_CLAIM`, `MCP_OAUTH_SCOPES` | from the issuer; `preferred_username`; none | Where the issuer's keys are, which claim names the user, which scopes a token must carry |
| `MCP_CF_ACCESS_TEAM_DOMAIN`, `MCP_CF_ACCESS_AUD` | none | Both set: a request that came through Cloudflare Access is authenticated by the assertion Access adds, verified against that team domain and that application's AUD tag ([docs/cloudflare-access.md](docs/cloudflare-access.md)) |

A setting weaker than the shipped default is accepted and reported once ([docs/space-guidelines.md](docs/space-guidelines.md), *Defaults and overrides*).

## Tools

`list-spaces`, `list-notes`, `read-note`, `read-multiple-notes`, `search-notes`, `create-note`, `edit-note`, `delete-note`, `render-note`, `screenshot-note`, with the names and inputs of v1 where they exist, plus a `space` parameter on each (default: the user's default space). `edit-note` needs the `revision` that `read-note` returned and has a `dryRun`. The semantics, the SilverBullet calls and the rights each tool needs are in [docs/architecture.md](docs/architecture.md), *Tool surface*.

## Rendering

`read-note` returns a page's source, as stored, with its `revision`; `render-note` returns the page as the user sees it, with `${…}` expressions, `query[[…]]` results (as HTML tables), templates and transclusions evaluated; `screenshot-note` returns a PNG of the page as SilverBullet's editor shows it. Both render tools go through SilverBullet's Runtime API as the calling user, need the `x` right in the access list, render pages (`.md`) only, return no `revision` (edits are always based on `read-note`), and are refused in a space where the scan has findings. How they work, the queue per `(user, space)`, the wait for the runtime's index after a write and the `system.reboot()` fallback: [docs/architecture.md](docs/architecture.md), section 5, and [docs/security.md](docs/security.md), section 12.

**Costs.** The first render of a user in a space starts a headless Chrome for that `(user, space)` pair inside the SilverBullet container: about **200 MiB**, plus the space's index; the first call takes 2 s on a tiny space and about 9 s on a space of 1,000 pages (the runtime indexes the space before it answers), later calls tens of milliseconds ([docs/architecture.md](docs/architecture.md), *Findings from the spike*). SilverBullet keeps the runtime until it restarts or an administrator stops it (*Admin → Runtimes*); the server cannot start, stop or count runtimes, and lists the pairs it has used on its report page. Grant `x` only where the SilverBullet container's memory allows one runtime per pair that may render. The Runtime API needs Write access and the per-user *Runtime API* grant in SilverBullet; a read-only member cannot render.

## Tests

```sh
npm run lint                                          # eslint and tsc
npm run test:unit                                     # the edit engine, the write filter, the access list, the credentials file, the verifiers
docker compose -f test/compose.yaml up -d --wait      # SilverBullet on http://127.0.0.1:3300
node test/bootstrap.ts                                # users, spaces, tokens, seed pages (idempotent)
npm run test:integration                              # the server against that instance, rendering included
node test/run.ts                                      # the release checks, report in test/report/<version>.md
docker compose -f test/compose.yaml down -v
```

Details, another SilverBullet release and a run without Docker: [test/README.md](test/README.md).

## Licence

[MIT](LICENSE).

Code is taken only from MIT, Apache-2.0 or BSD-licensed projects and is credited here and in the file it lands in. Projects under copyleft or non-OSI licences are read for ideas only.

## Attributions

* [SilverBullet](https://github.com/silverbulletmd/silverbullet) (MIT): the API behaviour this server relies on was read from its source and documentation; the bootstrap of the test instance follows its multi-space Runtime API end-to-end test. Four files of its Lua parser are vendored unchanged in `src/filter/vendor/silverbullet/` (`lua.grammar`, `parse-lua.js`, `parse-lua.terms.js`, `lua_comment.js`, at tag 2.12.1) with SilverBullet's `LICENSE.md` beside them; see [docs/security.md](docs/security.md), section 5.
* [Ahmad-A0/silverbullet-mcp](https://github.com/Ahmad-A0/silverbullet-mcp) (MIT, v1.2.0): `prepareEdits` and its error texts are copied into `src/edit.ts`; the tool names, input schemas and the shape of the results follow its `src/mcp-server.ts` and `src/edit-note.ts`.
* [xmatthewx/silverbullet-mcp-server](https://github.com/xmatthewx/silverbullet-mcp-server) (MIT): reviewed for its OAuth flow and tool surface. No code copied.
