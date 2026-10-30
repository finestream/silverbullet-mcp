# Architecture

Status: **proposed** (2026-10-30). This is the public record of the architecture decision for v2 of this server. The spike that backs it is in [`spike/`](../spike), the test instance in [`test/`](../test).

## Goal

One MCP server for a whole SilverBullet instance that, beyond reading and writing pages:

1. serves **several users**, each with their own credential, and acts towards SilverBullet as *that* user, so that SilverBullet's permissions decide what is allowed;
2. reaches **every space** of the instance that the user may access (SilverBullet ≥ 2.10 multi-space mode, spaces addressed as `/<space>`);
3. returns a page **rendered**, as Markdown with `${…}` expressions, queries, templates and transclusions evaluated, and as a **screenshot** (PNG).

It replaces a set-up of one single-user MCP server per user per space.

## Decision summary

| Topic | Decision |
|---|---|
| Base | **New implementation**, borrowing the tool surface and the conditional-edit logic of [Ahmad-A0/silverbullet-mcp](https://github.com/Ahmad-A0/silverbullet-mcp) (MIT), with attribution |
| Language | **TypeScript** on Node.js 24 LTS, official [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) |
| Transport | Streamable HTTP, **stateless** (no MCP sessions held by the server) |
| Auth, phase 1 | **Server-side credential map**: client bearer → user → that user's SilverBullet API token. No passthrough |
| Auth, phase 2 | OAuth 2.1 **resource server**; an external OIDC provider (for example Keycloak) issues the tokens; the user claim selects the entry in the same map |
| Addressing | A **`space` parameter** on every tool (default: the user's default space); a `list-spaces` tool |
| Space discovery | `GET /<space>/.config` with the user's token: it lists every space prefix and the user's `readOnly` flag; each space is probed with the user's token |
| Raw read | `/.fs` API with `ETag` / `If-Match`; never touches the Runtime API |
| Rendering | Opt-in tools over SilverBullet's **Runtime API**: `markdown.expandMarkdown` for Markdown, `/.runtime/screenshot` for PNG |
| Deployment | One container next to SilverBullet on the internal network; secrets from files; no Docker socket |

## Findings from the spike

Measured on 2026-10-30 against `ghcr.io/silverbulletmd/silverbullet:latest` = **2.12.1** (arm64, Docker Desktop, tiny test spaces). Scripts: [`spike/render.ts`](../spike/render.ts), [`spike/measure-runtime.sh`](../spike/measure-runtime.sh).

### Access and identity

* An API token issued to a user in the Dashboard works on every space that user may reach. No access: `403 Insufficient access to this space` (plain text). Unknown space: `404`. Missing or wrong token: `401`. Refusals are clear status codes, not `500`.
* A read-only member gets `403` on `PUT /.fs/…`. The `X-Permission` header and the `perm` field of the `/.fs` listing still say `rw` for that member, so they cannot be used to tell read from write. **`GET /<space>/.config` can**: it returns `readOnly: true|false` for the caller.
* The same `/.config` response lists **every space prefix** of the instance (`spacePrefixes`), live. A user's spaces are therefore found without admin rights and without reading `spaces.json`: read `/.config` of any reachable space, then probe each prefix's `/.config` with the user's token (200 → reachable, with `readOnly`; 403 → not).
* `/.dashboard/api/spaces` (the user's own space list) accepts only a session cookie, not an API token.
* Conditional writes: `If-Match` with a stale ETag → `412`; `If-None-Match: *` on an existing file → `412`. ETags are strong (`"sha256:…"`).
* The admin API (`/.dashboard/api/admin/*`) accepts an admin's API token as a bearer.

### Rendering as Markdown

The shortest working script (sent to `POST /<space>/.runtime/lua_script`):

```lua
return markdown.expandMarkdown(space.readPage(name))
```

It evaluates `${…}` expressions, `query[[…]]`, `template.each`/`template.new` and `![[transclusions]]`. Two gaps in 2.12.1, both handled in [`spike/render.ts`](../spike/render.ts):

* **`_CTX` is not set** inside `expandMarkdown`, so pages that use `_CTX.currentPage` render an error; `editor.navigate` first does not help. The script sets a global `_CTX = {currentPage = …}` around the call, which means renders on one runtime must be **serialised**. The edge release adds an `expandMarkdown(text, {pageName = …})` option that makes the shim unnecessary.
* **Query results come back as HTML tables** (`<table>…`), not Markdown tables. Readable for a model; converting them is optional.

| Measurement | Value |
|---|---|
| First call on a new runtime (browser launch + client boot + sync + index) | 1.8–1.9 s |
| Render of a page, warm | 30–50 ms |
| Index ready at the first call (queries complete) | yes, for a 5-page space; **to verify on a large space** |

### Screenshots

`editor.navigate(name)` through the Lua endpoint, then `GET /<space>/.runtime/screenshot`: 800×600 PNG, 30 KB, 70–110 ms warm. `?selector=%23sb-editor` clips to the editor (800×544). `?fullPage=1` is **ignored in 2.12.1** (same image); it is documented for the edge release, with a ~12000 px limit. Navigate and capture must be one serialised step per runtime.

### Cost of a runtime

Each **user + space** pair that uses the Runtime API gets its own headless Chrome inside the SilverBullet container.

| State | Container memory (cgroup) | Chrome processes |
|---|---|---|
| SilverBullet, no runtime | 8 MiB | 0 |
| + 1 runtime | 190 MiB | 6 |
| + 2 runtimes | 362 MiB | 12 |

About **175 MiB per runtime** for tiny spaces; it grows with the space (the client holds the index). SilverBullet starts a runtime lazily on the first `/.runtime/*` call and **never stops it on its own**: it lives until the server restarts, the user's write or runtime permission is removed, or an administrator stops it (*Admin → Runtimes*, or `POST /.dashboard/api/admin/runtimes/{id}/stop`).

### Runtime identity and the "a render must not write" rule

* The runtime runs as the token's user: from alice's `alpha` runtime, `fetch("/beta/.fs/Secret.md")` returns `401` (its cookie is scoped to `/alpha`); alice's call to `/beta/.runtime/*` returns `403`.
* The Runtime API **requires Write**: a read-only member gets `403`. Rendering is therefore available only where the user may write.
* A page whose expression writes (`${space.writePage(…)}`) **does write** when rendered unguarded, exactly as when the user opens it in the browser.
* Shadowing the `space.write*`/`delete*` functions during the render blocks that (the expression renders as `**Error:** rendering is read-only`). It is **best-effort**: Lua in a page can still reach `js.window.fetch` and `PUT` a file with the runtime's credentials. A read-only guarantee needs SilverBullet to offer a read-only runtime (see *Upstream*).

### Search

`/.search/*` (server-side full-text search) is not in 2.12.1; it is in the edge release. Until then, `search-notes` reads the pages through `/.fs` and matches in the MCP server, as v1 does.

## Decisions in detail

### 1. New implementation in TypeScript, borrowing from Ahmad-A0

| Criterion | Extend Ahmad-A0 v1.2.0 | New implementation |
|---|---|---|
| Multi-user, multi-space | Token, base URL, listing and content caches are module-level singletons; every API function and every tool would change | Designed in: a request context `{user, space, sbToken}` passed down |
| Conditional edit | `prepareEdits` + `edit-note` (~80 lines), clean, tested | Copy them, with attribution |
| Tests | ~590 lines (`node:test`), mostly against a stub | Integration tests against the compose test instance from day one |
| Size | ~1700 lines, 850 of them one file | Expected ~1500 lines across small modules |
| Auth | Bearer compared with `!==`; also accepted in the query string and the body | Constant-time compare of a hashed bearer; header only |

A fork would keep the history but change nearly every line; a fresh start keeps the parts that are good (tool names, input schemas, edit semantics, error texts) and leaves the rest. Tool names stay compatible so existing prompts keep working.

[xmatthewx/silverbullet-mcp-server](https://github.com/xmatthewx/silverbullet-mcp-server) (MIT) implements its own single-user OAuth authorization server. Phase 2 uses an external identity provider instead, so the MCP server only needs to be a *resource server* (verify tokens, publish RFC 9728 metadata); the SDK covers that. Its soft-delete to `_trash/` and `lastModified` collision check are ideas for later, not needed now.

TypeScript because SilverBullet itself, its plug API, both candidate servers and the most complete MCP SDK are TypeScript, and the maintainer reads it. Current Node.js versions run `.ts` files directly (type stripping), so the spike and tests need no build step; the server is compiled for the image.

### 2. Auth: server-side credential map (phase 1), resource server (phase 2)

```
client ── Bearer <client secret> ──▶ MCP server ── Bearer <SilverBullet API token of that user> ──▶ SilverBullet
                                      │
                                      └─ credentials file: sha256(client secret) → { user, sbToken, defaultSpace }
```

* One entry per user (a user may have several client secrets, one per client, to revoke them separately). The file holds the **SHA-256 of each client secret**, never the secret itself, and the user's SilverBullet token. It is mounted read-only as a secret file; the server re-reads it on change.
* The SilverBullet token never leaves the server. A leaked client secret works only against the MCP server's tools and is revoked by deleting its line; the SilverBullet token is revoked in the SilverBullet Dashboard.
* **Everything is keyed by user**: the page listing cache per `(user, space)` (TTL 30 s, dropped on the server's own writes), rate limits per user, render queues per `(user, space)`. No content is cached across users.

**Passthrough** (the client sends its SilverBullet token, the server forwards it) was considered again and rejected:

* *Caches keyed per token*: no longer an argument; with several users everything is keyed per user anyway.
* *The client holds the real credential*: still holds. A SilverBullet token can do more than the MCP tools (Runtime API with arbitrary Lua, shell and proxy endpoints where enabled).
* *MCP forbids token passthrough*: still holds. The [MCP security best practices](https://modelcontextprotocol.io/specification/latest/basic/security_best_practices) forbid accepting tokens not issued for the MCP server and forwarding them downstream. Phase 2 needs audience-bound tokens for the MCP server (RFC 8707), which would then be mapped to SilverBullet tokens anyway, so the map is needed in any case.

**Phase 2** replaces the bearer check with OAuth 2.1 token verification (issuer, audience = the MCP server's URL, expiry), publishes `/.well-known/oauth-protected-resource`, and looks the user up by a claim (`preferred_username`) in the same credentials file. The auth layer is one module with one interface (`authenticate(req) → user | 401`), so phase 2 swaps it without touching the tools.

### 3. Addressing: a `space` parameter

Every tool takes `space` (the prefix, `alpha` for `/alpha`); omitted, the user's `defaultSpace` from the credentials file is used, so v1-style calls with a bare filename keep working. A `list-spaces` tool returns the user's spaces with `access: read|write`.

* *`space/page` paths* were rejected: page names contain `/`, so `Work/Notes.md` is ambiguous (space `Work` or folder `Work`?).
* *One MCP resource root per space* was rejected: clients use tools, not resources, for model-driven access, and writes are tools anyway.

### 4. Rendering: opt-in tools over the Runtime API

* `render-note` (Markdown) and `screenshot-note` (PNG as MCP image content) are separate tools, **enabled per user** in the credentials file (`render: true`), and only work where SilverBullet grants that user Write and the Runtime API. `read-note` stays on `/.fs` and never starts Chrome.
* One **queue per `(user, space)`**: renders and screenshots on the same runtime run one at a time (the `_CTX` shim and navigate-then-capture are not concurrent-safe).
* The render script shadows `space.write*`/`delete*`. It is documented as best-effort (see the finding above).
* **Runtime lifetime**: SilverBullet keeps every runtime until restart, and only an administrator can see or stop runtimes. The server holds no admin token, so it cannot count or stop them; the number of runtimes is bounded instead by the pairs the administrator allows: users with `render: true` here × spaces where SilverBullet grants them the Runtime API. Stopping idle runtimes is left to SilverBullet (see *Upstream*), to the administrator, or to a periodic restart of SilverBullet.
* When SilverBullet offers `expandMarkdown{pageName}`, `fullPage` screenshots and `/.search`, the server uses them (feature-detected on the instance's version).

### 5. Deployment

One container (`node:24-alpine`, non-root, read-only root filesystem) on the same Docker network as SilverBullet, talking to `http://silverbullet:3000/<space>` directly. It is exposed through the reverse proxy on its own hostname; the MCP server checks the bearer itself. The credentials file is a compose secret. Health: `GET /healthz`. The headless Chrome runs **inside the SilverBullet container** (SilverBullet's own runtime), so the SilverBullet container's memory limit must allow ~200 MiB plus the space's index for every allowed `(user, space)` render pair.

## Tool surface (phase 1)

| Tool | SilverBullet call | Notes |
|---|---|---|
| `list-spaces` | `GET /<s>/.config` per prefix | `{space, access}` |
| `list-notes` | `GET /<s>/.fs` | `namePattern`, cursor paging |
| `read-note` | `GET /<s>/.fs/<path>` | returns `revision` (the ETag), offset/limit |
| `read-multiple-notes` | as above | |
| `search-notes` | `/.fs` + match in server | `/.search` when available |
| `create-note` | `PUT` + `If-None-Match: *` | |
| `edit-note` | `GET`, then `PUT` + `If-Match` | `expectedRevision`, `dryRun` returns the diff |
| `delete-note` | `DELETE` + `If-Match` | |
| `render-note` | `POST /<s>/.runtime/lua_script` | opt-in |
| `screenshot-note` | `lua_script` + `GET /<s>/.runtime/screenshot` | opt-in; `selector` |

`search-replace-note` from v1 is not carried over: it replaces case-insensitively everywhere without a revision check, and `edit-note` covers its use.

## Upstream (SilverBullet) requests worth making

1. **Read-only runtime**: a Runtime API mode whose headless client holds only read access (or a runtime for read-only members). It would make "a render must not write" enforceable and allow rendering for read-only members.
2. **Idle shutdown of runtimes** (for example `SB_RUNTIME_IDLE_TIMEOUT`), so that runtimes started for occasional renders do not stay resident until restart.
3. **API tokens on `/.dashboard/api/spaces`**: optional; probing `/.config` works.

## Open points for later tasks

* Index readiness on a large space at a runtime's first call (1b): measure, and wait for the index if needed.
* HTML tables in rendered Markdown: leave as is or convert (1b).
* Which OAuth client registration the clients need from the identity provider (dynamic client registration or client ID metadata documents) (phase 2).

## Test instance

```sh
docker compose -f test/compose.yaml run --rm bootstrap   # starts SilverBullet and bootstraps it; 3–4 s from empty
. test/.state/env                                         # SB_URL, SB_TOKEN_ALICE, SB_TOKEN_BOB, SB_TOKEN_ADMIN
node spike/render.ts                                      # rendering, isolation and screenshot checks
spike/measure-runtime.sh                                  # cold start and memory
docker compose -f test/compose.yaml down -v               # reset
```

| Space | Path | alice | bob |
|---|---|---|---|
| alpha | `/alpha` | write + Runtime API | read |
| beta | `/beta` | — | write + Runtime API |

The Runtime API needs no manual step: `silverbullet setup` writes `runtimeApi: true` to `server.json`, and the bootstrap also sets it through `PUT /.dashboard/api/admin/server-config`. Everything is created through SilverBullet's admin API (the same sequence its own multi-space end-to-end test uses), so CI can run it.
