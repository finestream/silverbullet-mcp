# Release checks and integration tests

`checks/` is a test suite that checks, per SilverBullet release, the behaviour the design of this server relies on: every assumption in [docs/facts/](../docs/facts/), [docs/security.md](../docs/security.md) and [docs/architecture.md](../docs/architecture.md) is an assertion here, or a documented skip. SilverBullet is in active development; this is how a release is found to have changed something before the server breaks on it.

## Run

Needs Node.js 24 or newer (it runs the `.ts` files directly) and a SilverBullet instance in multi-space mode with the Runtime API available. With Docker, from the repository root:

```sh
npm install                                           # the server's dependencies; playwright for the browser checks is optional
docker compose -f test/compose.yaml up -d --wait      # SilverBullet on http://127.0.0.1:3300
node test/run.ts                                      # bootstrap (idempotent), all checks, report
npm run test:integration                              # the server's integration tests, test/server/*.test.ts
docker compose -f test/compose.yaml down -v           # remove everything
```

Another release: `SB_IMAGE=ghcr.io/silverbulletmd/silverbullet:edge docker compose -f test/compose.yaml up -d --wait`, then the same run.

Without Docker, against any instance you run yourself (the server binary with `silverbullet setup <folder> --admin admin:<password>`, and `SB_CHROME_PATH` pointing at a Chromium for the Runtime API):

```sh
SB_URL=http://127.0.0.1:3300 SB_ADMIN_PASSWORD=<password> node test/run.ts
```

The bootstrap (`lib/bootstrap.ts`, also `node test/bootstrap.ts`) goes through the admin API: Runtime API on, users `alice`, `bob` and `scan` (the server's technical user, a write member of both spaces), spaces `alpha` and `beta`, one API token per user, the seed pages of `seed/`, the `CONFIG` pages of both spaces with the shipped transform block, and a plain `index` page for `beta` (SilverBullet's stock index page calls `config.get`, which the server's scan would report). Tokens land in `.state/env` (git-ignored). A second run keeps what exists. `node test/run.ts index parser` runs only the check files whose name contains one of the words.

The seed pages of `alpha` hold code outside `Library/` on purpose (`Outside`, `Styled`, `Side effect`, `Rendered`), so the server's scan always has findings there and rendering is blocked in `alpha`; `beta` is clean. The integration tests (`server/`) write the server's configuration files into a temporary directory from the tokens in `.state/env`, spawn `node src/main.ts` per scenario and talk to it with the MCP SDK's client; they clean up what they create.

The browser checks need Chromium for Playwright: `cd test && npx playwright install chromium`. Without it they are skipped, as with `SB_BROWSER=0`. The memory measurement reads the container's cgroup through `docker exec` (container name in `SB_CONTAINER`, default `sbmcp-test-silverbullet-1`); without Docker it is skipped.

Any Docker with Compose works; give the daemon or VM about 4 GB, since the container runs a Chromium per runtime.

## What is checked

| File | Assumptions |
|---|---|
| `checks/01-access.test.ts` | Tokens work per space; 401/403/404 as documented; read-only members; `/.config` with `spacePrefixes` and `readOnly`; conditional writes with strong ETags; the admin API with an admin token |
| `checks/02-runtime.test.ts` | `markdown.expandMarkdown` evaluates everything; the `_CTX` gap; the write guard and its `fetch` bypass; the runtime is the token's user and needs Write; screenshots, `?selector=`, `?fullPage=` |
| `checks/03-execution.test.ts` | Which fences execute; inert fences and code spans; query clauses as full Lua; `.lua` only through `dofile`; `.html` served inline without CSP; the event stream; how fast the headless runtime sees and indexes a write |
| `checks/04-index.test.ts` | What the index holds of `CONFIG` and `Library/`; the shipped transform block (verbatim as in the security model) and its effect on `space-lua` and `space-style`; survival across reload, reboot, reindex and a fresh runtime; the `return {}` defect; the hazard of an index built without the transform; scripts not reloaded after an incremental index; `CONFIG`'s objects cannot be dropped |
| `checks/05-parser.test.ts` | The write-filter matrix (63 cases, `src/filter/cases.ts`) with the shipped allowlist; the four vendored parser files of `src/filter/vendor/` unchanged at the release's tag; the pinned `@lezer/*` versions (both need the network) |
| `checks/06-cost.test.ts` | The filter's time per 50 KB page |
| `checks/07-browser.test.ts` | A fresh browser client (service worker, IndexedDB) boots with the transform active; an API write is indexed with its script replaced and a reload loads nothing |

Names that start with `[watch]` assert a limitation the design works around (`_CTX` unset, HTML tables, the `fetch` bypass, `fullPage` ignored, the `{}` defect, …). When such a check fails the report says *changed*: the release removed the limitation, and the workaround and the document that describes it need a look.

## Report

`node test/run.ts` writes `report/<version>.md`: every assumption with pass / fail / changed / skip and the note, plus the measurements the checks took (cold start, render, screenshot, indexing delays, filter time). The report for the release the design was made against is committed; a new release gets its own file.

## Layout

* `lib/sb.ts`: a client for the file API, `/.config`, the Runtime API, the event stream and the admin API.
* `lib/env.ts`: the instance (URL, tokens) and the fixtures; `lib/lua.ts`: the render script and the state query; `lib/transform.ts`: the shipped transform block and the variants the checks compare it with.
* `server/`: the server's integration tests and their harness (`harness.ts`: configuration files, a spawned server, an MCP client per bearer).
* `seed/`: the pages of the test spaces.
* The write filter and the vendored parser are the server's, under `src/filter/`.
