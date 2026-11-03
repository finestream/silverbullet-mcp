# silverbullet-mcp

An MCP server for a [SilverBullet](https://silverbullet.md) instance in multi-space mode: several agents, each acting as its own SilverBullet user, every space that user may reach, and pages rendered the way SilverBullet shows them.

## Goals

One MCP server for a whole SilverBullet instance that, beyond reading and writing pages:

1. serves **several agents**, each with its own credential and its own SilverBullet user, and acts towards SilverBullet as *that* user, so that SilverBullet's permissions decide what is allowed and every write stays attributable to a user;
2. reaches **every space** of the instance that the agent's user may access (SilverBullet ≥ 2.10 multi-space mode, spaces addressed as `/<space>`);
3. returns a page **rendered**, as Markdown with `${…}` expressions, queries, templates and transclusions evaluated, and as a **screenshot** (PNG), next to the raw source;
4. keeps the **revision-guarded `edit-note`** with `dryRun`, so that clients written for v1 keep working;
5. runs behind a reverse proxy with **secrets from files**, and can later verify **OAuth tokens** instead of static bearers;
6. **restricts each agent further than SilverBullet does**, by path, with a deny-by-default access list per user and group that never widens what SilverBullet grants and applies to every tool, listings and search included;
7. **keeps code out of the pages agents write**, so that a page an agent wrote can be opened and rendered by any person without running anything but audited code;
8. is **MIT**, with code taken only from MIT, Apache or BSD sources.

It replaces a set-up of one single-user MCP server per user per space, called v1 in these documents ([Ahmad-A0/silverbullet-mcp](https://github.com/Ahmad-A0/silverbullet-mcp), one instance per identity): there, every additional identity costs one more container, and pages come back only as raw source, so queries do not show their results. How the server meets the goals is in [docs/architecture.md](docs/architecture.md).

## The security challenge

SilverBullet runs code from content: every Space Lua block and every `${…}` expression on any page runs in the browser of the person who opens the page, with that person's rights. An agent that can write one page can plant code that reads or writes everything, and a path-based access list does not close this: it decides where an agent may write, not what the written page may do. The server therefore keeps code out of the pages agents write and confines it to `Library/`, with configuration in `CONFIG`; the full model, and the terms *user*, *person*, *agent* and *operator* as these documents use them, are in [docs/security.md](docs/security.md).

## Posture

The server ships strict: a deny-by-default access list, a write filter on every write with an allowlist of the functions a page may call, a scan of the space in report-only mode, an index-time transform in `CONFIG` that keeps blocks outside `CONFIG` and `Library/` from loading, a refusal to serve while any of these is missing, and no rendering in a space where the scan has findings. Every part but the last two can be relaxed (write access to `Library/`, more allowlist entries, more file types, scan off or in quarantine mode), and the server reports a relaxed setting once at start, in its log and on its report page in the space ([docs/security.md](docs/security.md), section 11). The rules, the defaults that enforce them, and what relaxing each one accepts are in [docs/space-guidelines.md](docs/space-guidelines.md); how the controls work is in [docs/security.md](docs/security.md).

## Status

**Core server, phase 1a.** The server in `src/` serves the eight tools below as the authenticated user, with the credentials file, the access list, the write filter, the scan with its report page, and the refusal to serve. Not yet: the rendered pages (`render-note`, `screenshot-note`, phase 1b), the deployment next to a production instance (1c) and OAuth (2). The architecture and the security model are in `docs/`; the *release checks* in `test/` assert, per SilverBullet release, the behaviour the design relies on.

## What is here

| Path | What |
|---|---|
| [`docs/architecture.md`](docs/architecture.md) | Architecture decision for v2, with the measurements of the Runtime API spike |
| [`docs/security.md`](docs/security.md) | Security model: threat model, access list, write filter, allowlist, scan, index-time transform, defaults |
| [`docs/space-guidelines.md`](docs/space-guidelines.md) | Conventions a space follows when this server guards it |
| [`docs/facts/`](docs/facts) | Measured behaviour of SilverBullet 2.12.1 that the security model rests on |
| [`src/`](src) | The server: `main.ts` (entry, `--scan`, `--hash`), `server.ts` (HTTP, auth), `tools.ts` (the tools), `filter/` (the write filter on the vendored parser, the allowlist), `access.ts`, `credentials.ts`, `scan.ts`, `edit.ts`; unit tests beside the code |
| [`config/`](config) | The shipped allowlist and examples of the credentials file, the access list and the allowed-files list |
| [`test/`](test) | The release checks (a compose test instance, a bootstrap through the admin API, one check per assumption, a report per SilverBullet version) and, in `test/server/`, the server's integration tests against the same instance |
| [`Dockerfile`](Dockerfile), [`compose.example.yaml`](compose.example.yaml) | The image (`node:24-alpine`, non-root) and how to run it next to SilverBullet with secrets from files |
| [`.github/workflows/ci.yml`](.github/workflows/ci.yml) | Lint, unit and integration tests on every pull request; the image to `ghcr.io/finestream/silverbullet-mcp` on a version tag |

## Run

Needs Node.js 24 or newer (it runs the `.ts` files directly) and a SilverBullet instance in multi-space mode, 2.12 or newer.

```sh
npm install
MCP_CREDENTIALS_FILE=./secrets/credentials MCP_CONFIG_DIR=./config SB_URL=http://127.0.0.1:3000 node src/main.ts
```

The server listens on `PORT` (default 4000): `POST /mcp` is the MCP endpoint (streamable HTTP, stateless, bearer in the `Authorization` header), `GET /healthz` the health check. Clients that speak only stdio reach it through [`mcp-remote`](https://www.npmjs.com/package/mcp-remote) with the bearer as a header. The image does the same: see [compose.example.yaml](compose.example.yaml).

Two more modes: `node src/main.ts --scan` runs one scan over the guarded spaces and exits with 1 on findings (the installation step of [docs/security.md](docs/security.md), section 7); `printf '%s' "$SECRET" | node src/main.ts --hash` prints the SHA-256 of a client secret for the credentials file.

## Configuration

Three files and a few variables. The files are re-read when they change; a `SIGHUP` re-reads them and runs a scan.

| File | Variable | What |
|---|---|---|
| credentials (a secret) | `MCP_CREDENTIALS_FILE`, default `/run/secrets/credentials` | One line per SilverBullet user: API token, default space, groups, bearer hashes; the line `scan` for the technical user ([example](config/credentials.example); [docs/security.md](docs/security.md), section 3) |
| access list | `MCP_ACCESS_LIST_FILE`, default `$MCP_CONFIG_DIR/access-list` | What each user or group may do per space and path ([example](config/access-list.example); [docs/security.md](docs/security.md), section 4) |
| allowlist | `MCP_ALLOWLIST_FILE`, default `$MCP_CONFIG_DIR/allowlist` | The functions a page may call ([shipped default](config/allowlist); [docs/security.md](docs/security.md), section 6) |
| allowed files | `MCP_ALLOWED_FILES_FILE`, default `$MCP_CONFIG_DIR/allowed-files`, optional | Non-page files the scan may ignore ([example](config/allowed-files.example); [docs/security.md](docs/security.md), section 7) |

| Variable | Default | What |
|---|---|---|
| `SB_URL` | `http://silverbullet:3000` | The SilverBullet instance; spaces are addressed as `/<space>` below it |
| `PORT` | `4000` | The listening port |
| `MCP_CONFIG_DIR` | `/etc/silverbullet-mcp` | Where the access list, the allowlist and the allowed-files list are, unless given one by one |
| `MCP_SPACES` | all the scan user can see | The spaces to guard, comma-separated |
| `MCP_FILE_TYPES` | `.md` | The file types the server writes ([docs/security.md](docs/security.md), section 5) |
| `MCP_SCAN_INTERVAL` | `15m` | Time between scans (`0`: at start and on `SIGHUP` only) |
| `MCP_SCAN_MODE` | `report` | `report` or `quarantine` ([docs/security.md](docs/security.md), section 7) |
| `MCP_REPORT_PAGE` | `MCP Server` | The report page, written at the top level of every guarded space ([docs/security.md](docs/security.md), section 8) |
| `MCP_RATE_LIMIT` | `120` | Tool calls per user and minute; `0` for none |
| `MCP_LOG_LEVEL` | `info` | `info` or `debug`; the log is JSON lines on stdout |

A setting weaker than the shipped default is accepted and reported once ([docs/space-guidelines.md](docs/space-guidelines.md), *Defaults and overrides*).

## Tools

`list-spaces`, `list-notes`, `read-note`, `read-multiple-notes`, `search-notes`, `create-note`, `edit-note`, `delete-note`, with the names and inputs of v1 where they exist, plus a `space` parameter on each (default: the user's default space). `edit-note` needs the `revision` that `read-note` returned and has a `dryRun`. The semantics, the SilverBullet calls and the rights each tool needs are in [docs/architecture.md](docs/architecture.md), *Tool surface*.

## Tests

```sh
npm run lint                                          # eslint and tsc
npm run test:unit                                     # the edit engine, the write filter, the access list, the credentials file
docker compose -f test/compose.yaml up -d --wait      # SilverBullet on http://127.0.0.1:3300
node test/bootstrap.ts                                # users, spaces, tokens, seed pages (idempotent)
npm run test:integration                              # the server against that instance
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
