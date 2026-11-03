# Architecture

Status: **proposed** (2026-10-30, revised 2026-11-03). This document records the architecture of v2 of this server: the decisions, the alternatives rejected and the measurements they rest on. The security model (write filter, allowlist, scan, index-time transform, refuse-to-serve) is in [security.md](security.md), the conventions a guarded space follows in [space-guidelines.md](space-guidelines.md), and the measured behaviour of SilverBullet 2.12.1 in [facts/](facts/). The spike scripts and the compose test instance that back the measurements below are kept on a branch of their own until the release checks absorb them.

## Goal

The goals are stated once, in the [README](../README.md#goals); this document says how the server meets them.

## Decision summary

| Topic | Decision |
|---|---|
| Base | **New implementation**, borrowing the tool surface and the conditional-edit logic of [Ahmad-A0/silverbullet-mcp](https://github.com/Ahmad-A0/silverbullet-mcp) (MIT), with attribution |
| Language | **TypeScript** on Node.js 24 LTS, official [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) |
| Transport | Streamable HTTP, **stateless** (no MCP sessions held by the server) |
| Auth, phase 1 | **Server-side credential map**: client bearer → user → that user's SilverBullet API token. No passthrough |
| Auth, phase 2 | OAuth 2.1 **resource server**; an external OIDC provider (for example Keycloak) issues the tokens; the user claim selects the entry in the same map |
| Access control | SilverBullet is the ceiling; below it an **access list** per user or group, space and path (`r`, `w`, `d`, `x`, `-`), deny by default, the most specific path wins, applied to every tool |
| Content | Pages hold no code: a **write filter** on every write, a **scan** of the space, an **index-time transform** in `CONFIG`, and an **allowlist** of the functions a page may call ([security.md](security.md)) |
| Addressing | A **`space` parameter** on every tool (default: the user's default space); a `list-spaces` tool |
| Space discovery | `GET /<space>/.config` with the user's token: it lists every space prefix and the user's `readOnly` flag; each space is probed with the user's token |
| Raw read | `/.fs` API with `ETag` / `If-Match`; never touches the Runtime API |
| Rendering | Opt-in tools (`x` in the access list) over SilverBullet's **Runtime API**: `markdown.expandMarkdown` for Markdown, `/.runtime/screenshot` for PNG |
| Deployment | One container next to SilverBullet on the internal network; secrets from files; no Docker socket |

## Findings from the spike

Measured on 2026-10-30 against `ghcr.io/silverbulletmd/silverbullet:latest` = **2.12.1** (arm64, Docker Desktop, tiny test spaces) with a render script of 17 checks and a memory measurement script, against the test instance described at the end of this document.

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

It evaluates `${…}` expressions, `query[[…]]`, `template.each`/`template.new` and `![[transclusions]]`. Two gaps in 2.12.1, both handled in the spike's render script:

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
* Shadowing the `space.write*`/`delete*` functions during the render blocks that (the expression renders as `**Error:** rendering is read-only`). It is **best-effort**: Lua in a page can still reach `js.window.fetch` and `PUT` a file with the runtime's credentials. A read-only guarantee needs SilverBullet to offer a read-only runtime (see *Possible improvements in SilverBullet*).

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

The other SilverBullet MCP servers looked at (bong-u, seanmcilvenna, silverbullet-ai-mcp, kesor, wicahma, jgurhem) and the MCP gateways mcp-front and Bifrost are all young, and none serves several users or renders pages. bong-u comes closest to the access list (path scopes in the MCP layer), but it serves a single user.

Go and Python were possible too: both have official MCP SDKs.

TypeScript because SilverBullet itself, its plug API, both candidate servers and the most complete MCP SDK are TypeScript, and the maintainer reads it. Current Node.js versions run `.ts` files directly (type stripping), so the spike and tests need no build step; the server is compiled for the image.

### 2. Auth: server-side credential map (phase 1), resource server (phase 2)

```
client ── Bearer <client secret> ──▶ MCP server ── Bearer <SilverBullet API token of that user> ──▶ SilverBullet
                                      │
                                      └─ credentials file: sha256(client secret) → { user, sbToken, defaultSpace, groups }
```

* One entry per user (a user may have several client secrets, one per client, to revoke them separately). The file holds the **SHA-256 of each client secret**, never the secret itself, the user's SilverBullet token, the user's default space and the **groups** the user belongs to. It is mounted read-only as a secret file; the server re-reads it on change. Adding a user is one entry here plus its lines in the access list (section 3), or none if a group entry already covers it.
* The SilverBullet token never leaves the server. A leaked client secret works only against the MCP server's tools and is revoked by deleting its line; the SilverBullet token is revoked in the SilverBullet Dashboard.
* **Everything is keyed by user**: the page listing cache per `(user, space)` (TTL 30 s, dropped on the server's own writes), rate limits per user, render queues per `(user, space)`. No content is cached across users.

**Passthrough** (the client sends its SilverBullet token, the server forwards it) was considered again and rejected:

* *Caches keyed per token*: no longer an argument; with several users everything is keyed per user anyway.
* *The client holds the real credential*: still holds. A SilverBullet token can do more than the MCP tools (Runtime API with arbitrary Lua, shell and proxy endpoints where enabled).
* *MCP forbids token passthrough*: still holds. The [MCP security best practices](https://modelcontextprotocol.io/specification/latest/basic/security_best_practices) forbid accepting tokens not issued for the MCP server and forwarding them downstream. Phase 2 needs audience-bound tokens for the MCP server (RFC 8707), which would then be mapped to SilverBullet tokens anyway, so the map is needed in any case.

**Phase 2** replaces the bearer check with OAuth 2.1 token verification (issuer, audience = the MCP server's URL, expiry), publishes `/.well-known/oauth-protected-resource`, and looks the user up by a claim (`preferred_username`) in the same credentials file. The tokens come from an external OIDC provider (for example Keycloak); the MCP server is only a resource server and runs no authorization server of its own. The auth layer is one module with one interface (`authenticate(req) → user | 401`), so phase 2 swaps it without touching the tools. Until phase 2, clients that speak only stdio reach the server through `mcp-remote` with a static bearer; clients that require OAuth (for example web connectors) can connect only from phase 2 on.

**No admin token.** The server holds only the users' own SilverBullet tokens. Rejected alternatives:

* *Mint SilverBullet tokens with an admin token*: one shared admin credential in the server, and writes no longer attributable to a user's own token.
* *An admin token only to stop idle runtimes*: SilverBullet's admin API accepts no narrower token, so it would be a full admin credential for one housekeeping task. Revisit if SilverBullet adds idle shutdown or a narrower role (see *Possible improvements in SilverBullet*).

### 3. Access control: SilverBullet is the ceiling, an access list below it

SilverBullet grants rights per space. The server passes SilverBullet's refusals (`401`, `403`, `404`, `412`) through as clear messages (for example "no write access to space alpha"; a refusal by the access list says so, too) and never widens them. Below that ceiling an **access list** beside the credentials file says, per user or group, space and path, what the user may do through the MCP server:

| Right | Allows |
|---|---|
| `r` | read, list, search |
| `w` | create and edit |
| `d` | delete |
| `x` | render and screenshot |
| `-` | nothing: an explicit denial |

* **Paths** are the whole space, an exact page, or a folder ending in `/`.
* **Deny by default; the most specific path wins.** A rule for `Projects/` and a narrower one for `Projects/Private/` combine as expected. On the same path a user entry wins over group entries; between groups `-` wins, otherwise rights add up.
* **Groups** are named on the user's line of the credentials file; a user may be in several. The shipped default is a group `agents` with `r` on the space, `-` on `CONFIG`, `SETTINGS` and `Library/`, and write rights only where the operator grants them ([security.md](security.md), section 4).
* **Applied to every tool**, listings and search included: a page the user may not read is absent from `list-notes` and `search-notes` results, not only refused on `read-note`.
* **Why the server may restrict at all:** a server-side restriction is only worth something if the client cannot go around it. Because the client never holds a SilverBullet token (section 2), the MCP server is its only route, and the list holds. SilverBullet stays the ceiling, so the list never hides what SilverBullet itself enforces.
* The list restricts the **MCP route only**. Lua that runs inside SilverBullet (for example in a render, see section 5) runs with the user's full space rights.

### 4. Addressing: a `space` parameter

Every tool takes `space` (the prefix, `alpha` for `/alpha`); omitted, the user's `defaultSpace` from the credentials file is used, so v1-style calls with a bare filename keep working. A `list-spaces` tool returns the user's spaces with their effective rights: SilverBullet's `read|write`, narrowed by the access list.

* *`space/page` paths* were rejected: page names contain `/`, so `Work/Notes.md` is ambiguous (space `Work` or folder `Work`?).
* *One MCP resource root per space* was rejected: clients use tools, not resources, for model-driven access, and writes are tools anyway.

### 5. Rendering: opt-in tools over the Runtime API

* `render-note` (Markdown) and `screenshot-note` (PNG as MCP image content) are separate tools. They need **`x` in the access list** for the page, and only work where SilverBullet grants that user Write and the Runtime API; a user with read-only access to a space cannot render there. `read-note` stays on `/.fs` and never starts Chrome. Both render `.md` pages only.
* **Rendering is for reading; editing works on the source.** `read-note` returns the raw Markdown as stored, with its `revision`; `render-note` returns the expansion and no `revision`, and `edit-note` requires one, so every edit is based on the source. After a write, a render waits (bounded) until the runtime's index holds the new revision, with a fresh runtime as fallback ([security.md](security.md), section 12).
* One **queue per `(user, space)`**: renders and screenshots on the same runtime run one at a time (the `_CTX` shim and navigate-then-capture are not concurrent-safe).
* The render script shadows `space.write*`/`delete*`. It is documented as best-effort (see the finding above): Lua in a page can still write through the runtime's browser with the user's full space rights, past the access list. What makes `x` safe to grant is that pages hold no code: the write filter, the scan and the index-time transform ([security.md](security.md), sections 5, 7 and 10). A page that writes when rendered does the same when opened in the browser and is a defect of that page.
* **Runtime lifetime**: SilverBullet keeps every runtime until restart, and only an administrator can see or stop runtimes. The server holds no admin token (section 2), so it cannot count or stop them; the number of runtimes is bounded instead by the `(user, space)` pairs the administrator allows: `x` somewhere in that space in the access list, and the Runtime API granted by SilverBullet. Each runtime costs about 200 MiB, so granting `x` is the administrator's call. Stopping idle runtimes is left to SilverBullet (see *Possible improvements in SilverBullet*), to the administrator, or to a periodic restart of SilverBullet.
* When SilverBullet offers `expandMarkdown{pageName}`, `fullPage` screenshots and `/.search`, the server uses them (feature-detected on the instance's version).
* *Rendering in the MCP server itself* (its own Lua or Markdown engine) was rejected: queries, templates and widgets live in SilverBullet's client, and only the Runtime API runs them as the user.

### 6. Deployment

One container (`node:24-alpine`, non-root, read-only root filesystem) on the same Docker network as SilverBullet, talking to `http://silverbullet:3000/<space>` directly. It is exposed through the reverse proxy on its own hostname; the MCP server checks the bearer itself. The credentials file and the access list are compose secrets. Health: `GET /healthz`. The headless Chrome runs **inside the SilverBullet container** (SilverBullet's own runtime), so the SilverBullet container's memory limit must allow ~200 MiB plus the space's index for every allowed `(user, space)` render pair. Check that limit before allowing rendering for more than one or two pairs.

## Tool surface (phase 1)

| Tool | SilverBullet call | Notes |
|---|---|---|
| `list-spaces` | `GET /<s>/.config` per prefix | `{space, access}`, narrowed by the access list |
| `list-notes` | `GET /<s>/.fs` | `namePattern`, cursor paging |
| `read-note` | `GET /<s>/.fs/<path>` | returns `revision` (the ETag), offset/limit |
| `read-multiple-notes` | as above | |
| `search-notes` | `/.fs` + match in server | `/.search` when available |
| `create-note` | `PUT` + `If-None-Match: *` | write filter on the result |
| `edit-note` | `GET`, then `PUT` + `If-Match` | `expectedRevision`, `dryRun` returns the diff; write filter on the result |
| `delete-note` | `DELETE` + `If-Match` | needs `d` |
| `render-note` | `POST /<s>/.runtime/lua_script` | needs `x`; `.md` only; no `revision` |
| `screenshot-note` | `lua_script` + `GET /<s>/.runtime/screenshot` | needs `x`; `.md` only; `selector` |

Every tool checks the access list before calling SilverBullet: `r` for the read tools, `w` for `create-note` and `edit-note`, which also run the write filter and the file-type check ([security.md](security.md), section 5). While the server is in its refuse-to-serve state ([security.md](security.md), section 9), only `list-spaces` and the health endpoint answer.

`search-replace-note` from v1 is not carried over: it replaces case-insensitively everywhere without a revision check, and `edit-note` covers its use.

## Possible improvements in SilverBullet

Changes in SilverBullet that would simplify or strengthen this architecture. Each is a candidate for a proposal upstream; until then the architecture works around it as described above.

1. **Read-only runtime**: a Runtime API mode whose headless client holds only read access (or a runtime for read-only members). It would make "a render must not write" enforceable and allow rendering for read-only members.
2. **Idle shutdown of runtimes** (for example `SB_RUNTIME_IDLE_TIMEOUT`), so that runtimes started for occasional renders do not stay resident until restart.
3. **API tokens on `/.dashboard/api/spaces`**: optional; probing `/.config` works.
4. **Tag transforms returning `{}`**: the documentation says the object is not indexed; in 2.12.1 the empty table reaches the indexer as an object without `ref` and the whole page drops out of the index ([facts/index-transform.md](facts/index-transform.md), section 4).
5. **`.html` files served inline without a Content Security Policy** on the space's origin ([facts/execution-model.md](facts/execution-model.md), section 3).

## Open points for later tasks

* Index readiness on a large space at a runtime's first call: measure, and wait for the index if needed (rendering).
* HTML tables in rendered Markdown: leave as is or convert (rendering).
* Which OAuth client registration the clients need from the identity provider (dynamic client registration or client ID metadata documents) (phase 2).

## Test instance

The measurements were taken on a compose set-up: SilverBullet 2.12 in multi-space mode, two spaces, two users with different grants, bootstrapped through the admin API in one command (3–4 s from empty, idempotent, tokens written to a git-ignored state file). It is kept on a branch of its own and comes back with the release checks.

| Space | Path | alice | bob |
|---|---|---|---|
| alpha | `/alpha` | write + Runtime API | read |
| beta | `/beta` | — | write + Runtime API |

The Runtime API needs no manual step: `silverbullet setup` writes `runtimeApi: true` to `server.json`, and the bootstrap also sets it through `PUT /.dashboard/api/admin/server-config`. Everything is created through SilverBullet's admin API (the same sequence its own multi-space end-to-end test uses), so CI can run it.
