# Facts: SilverBullet 2.12.1 execution model and index exposure

Seven questions about where SilverBullet runs code and what its index exposes, answered from the source at tag `2.12.1` (commit `4d5eac5`) and from tests on a local instance (see [README.md](README.md)). Tests ran as a write member of a test space through `POST /<space>/.runtime/lua_script`; queries are quoted where they matter.

## 1. Which fenced blocks execute or apply

**Answer.** Two fence languages are active: `space-lua` (Lua, executed in every client) and `space-style` (CSS, injected into every client). `space-config` is only a syntax-highlighting name in 2.12.1; nothing reads it. No other fence language executes by itself. A `space-lua` script can register a *code widget* for any language, which then renders when a page with such a fence is shown; that is trusted code at work, not a new door.

**When `space-lua` is loaded.**

* Indexed from every page as `space-lua` objects with the full script text, ref `page@offset` (`plugs/index/space_lua.ts:17-50`).
* Executed by `SpaceLuaEnvironment.reload()` (`client/space_lua.ts:60-150`): queries the index for all `space-lua` objects and runs every block in priority order in one global environment.
* Triggers: client boot (`client/client.ts:389-391`); end of the initial index and a version-bump reindex (`client/data/object_index.ts:159,483` dispatch `editor:reloadState`, handled in `client/client_system.ts:191,422`); on demand `System: Reload`, `system.loadScripts()`, `system.reboot()` (`client/plugos/syscalls/system.ts:153-200`). **Not** after the incremental index of a changed page: no such caller exists. Test B (a new page with a `space-lua` block written on disk) showed the page indexed after 0.6 s and its function still undefined 90 s later; it was defined right after `system.loadScripts()`.
* Boot-time pass over `CONFIG`: before anything else, `client/boot_config.ts:22-45` extracts the `space-lua` blocks of `CONFIG` and runs them in a contained environment (config, editor, markdown, system syscalls only; `:50-100`).
* A block inside an HTML comment `<!-- … -->` is inert (`plugs/index/indexer.ts:51`, `client/boot_config.ts:28-31`); test C2.

**When `space-style` is applied.** Indexed (`plugs/index/space_style.ts`), concatenated into `<style>` elements at boot and on every reload (`client/client.ts:1244-1277`). Only switch: the client URL parameter `?disableSpaceStyle=1` (`client/boot.ts:308`).

**With whose rights.** In the browser: with the session of whoever opens the space, read members included (`docs/Security.md`, *Access levels*: read "will run all scripts and queries locally"; `docs/Dashboard.md:37`). In the Runtime API: as the token's user; the headless client is a complete client that boots, indexes and runs all scripts (test *boot*: `mylib_fn`, defined in `Library/Mine`, and `config.get("agentTest.secret")` from `CONFIG` were both available on the first call, 3.3 s cold). The Runtime API needs write access and the per-user *Runtime API* permission (`docs/Runtime API.md`, *Setup*; `docs/Security.md`, *Capability endpoints*).

**Runaway control, not access control.** Each script runs under a CPU budget (2 s busy, `client/space_lua/budget.ts:5`); the user may stop it, which quarantines that script hash in the browser's localStorage (`client/space_lua/quarantine.ts`). Local to that browser.

## 2. Where `${...}` and `query[[...]]` are evaluated

**Answer.**

1. In the editor, on page show (live preview): `client/codemirror/lua_directive.ts:15-110` turns every `LuaDirective` node into a widget unless the cursor is inside it. Skipped on pages tagged `meta/template` and when the page decoration `renderWidgets` is `false` (`client/codemirror/util.ts:280-283`).
2. In every Markdown expansion: `client/markdown_renderer/inline.ts:148-195` evaluates the expression with the global environment (option `expandLuaDirectives`, default on). This serves transclusions, templates and `markdown.expandMarkdown`, which is the Runtime API render path.
3. Not at indexing: the indexers only parse (`plugs/index/indexer.ts`). But a `tag.define { transform = … }` callback is Lua that runs for every indexed object of that tag (`docs/API/tag.md:55-68`).
4. Baked sections `<!--#lua EXPR -->` re-evaluate only on the manual command (`docs/Baked Sections.md`).

**The `where` clause is a full Lua expression.** Parsed as `LuaExpression` (`client/space_lua/parse.ts:1567-1570`), evaluated per row by `evalExpression` (`client/space_lua/query_collection.ts:652-661`). Tests:

* D1 `where string.find(space.readPage("CONFIG"), "CONFIG%-SECRET") ~= nil` matched: a query reads `CONFIG` while filtering.
* D2 `where (function() return true end)()`: a function defined inside the clause runs.
* D3 `where (function() _G.leaked = "set-from-where" return true end)()`: the assignment stuck; `_G.leaked` read it back.

The same holds for `select`, `order by`, `having`, `limit`, `offset` (all `<<expression>>`, `docs/Space Lua/Integrated Query.md:19-27`). A query exists only inside `${…}` or a script; there is no standalone query block in 2.12.1.

## 3. Execution outside `.md` pages

**Answer.** Yes, two ways, and one hazard.

* **`*.plug.js` anywhere in the space** is loaded as a plug, a web worker, in every client (`client/space.ts:74-77` lists plugs by file suffix; synced regardless of ignore rules, `client/service_worker/sync_engine.ts:280-283`). JavaScript with the user's rights through syscalls.
* **`.lua` files** execute only when a script calls `dofile(path)` (`client/space_lua/stdlib.ts:489-512`: reads the file through `space.readFile`, parses, evaluates in the global environment). Never by themselves: test E1 `from_lua_file` nil; E2 `dofile("code.lua")` then the call returned `"lua-file-ran"`.
* **`.html` files** do not execute inside SilverBullet, but `/.fs/` serves them inline with their content type, without `Content-Disposition` and without a CSP (`server/src/handlers/fs.rs:66-73`, and its tests `html_file_is_served_inline`, `partial_responses_preserve_type_negotiation_and_inline_files`, around `:1815-1860` and `:2318-2335`; the only CSP header in the server is on the central auth page, `server/src/handlers/central_auth.rs:385`). An `.html` file opened by its URL runs its script on the space's origin with the viewer's session cookie.
* Other documents and attachments: no execution path found. Dot-prefixed files and directories are refused by the API (CHANGELOG 2.12.1, first entry).

## 4. External edits: how and how fast

**Answer.** Server: a `notify` watcher on the space folder, 75 ms debounce, events pushed on the `/.events` SSE stream; if the watcher cannot start, a poll every 30 s (`SB_FS_POLL_INTERVAL`) (`server/src/watcher.rs:1-5, 197-205, 221-223`). Client: an SSE event triggers the sync of that file at once (`client/realtime_events.ts:1-12`); backstops are the full-space sync every 20 s (60 s while SSE is healthy) and the open file every 2–3 s (`client/service_worker/sync_engine.ts:25-26`, `docs/Sync.md`). The changed page is then re-indexed in the background ("can lag a few seconds", `docs/Object Index.md`).

Test B, file written on disk by another process while the runtime was warm: `space.readPage` saw it after 0.0 s (the headless client runs without service worker and reads through to the server), `index.tag "page"` listed it after 0.6 s. Its `space-lua` block was indexed with it but **not loaded** until a script reload (section 1). A git checkout or a sync client is the same path: a write on disk.

## 5. Renamed fence and backticked expression

**Answer.** Both are inert and stay visible.

* A ```` ```lua ```` fence is only highlighted (`client/languages.ts:15`); the indexer keeps `space-lua` alone (`plugs/index/space_lua.ts:29`). Test C2: `inert_marker` defined in a `lua` fence was nil; no `space-lua` object for the page.
* `${…}` in backticks is inline code. The directive is an inline parser (`client/markdown_parser/parser.ts:93-157`) that does not run inside code spans. Test C1, `markdown.expandMarkdown` of the page: `` `${1 + 1}` `` came back literally, the plain `${2 + 2}` next to it became `4`. The editor uses the same parser.
* Caveat for the fence: trusted code can register a code widget for the language `lua` (section 1); not the case by default.

## 6. What the index holds of `CONFIG` and `Library/`

**Answer.**

* **Every `space-lua` block, full source, from every page**, `CONFIG` included. Test A1, `from s = index.tag "space-lua" where string.startsWith(s.ref, "CONFIG@") … select {ref = s.ref, script = s.script}` returned `{ref = "CONFIG@14", script = "config.set(\"agentTest.secret\", \"CONFIG-SECRET-4711\")\nlocal hidden = …"}`. These objects carry no `page` field, only `ref` (`plugs/index/space_lua.ts:41-46`).
* **Values set with `config.set` in `CONFIG`** are not in the index but readable from any expression: `config.get("agentTest.secret")` returned the value (test *boot*).
* **Page objects:** `CONFIG` and every Library page are in `index.tag "page"` (A2). `index.contentPages()` only drops pages tagged `meta` or `meta/*`; `Library/Std` is, `CONFIG` is not (A3).
* **Paragraphs** are indexed only when tagged or anchored, unless `config.set("index.paragraph.all", true)` (`plugs/index/paragraph.ts:33,54`); A4 found none for `CONFIG` and `Library/Mine`. **Items and tasks** are all indexed by default (`plugs/index/item.ts:50-51`); A5 returned the Library item with its text.
* **Full text** is not indexed in core (`docs/Full Text Search.md`). But `space.readPage("CONFIG")` from any expression returns the source (A6), `space.readFile` any file.
* **Exclusion.** No per-page "do not index" flag exists (none in `plugs/index`, `client/data/object_index.ts`). Two supported levers:
    * `config.set("sync.ignore", {patterns})` keeps files out of the browser's local copy and so out of its index (`docs/Sync.md`). Whether the headless runtime honours it: not tested.
    * `tag.define { name = "<tag>", transform = function(o) … end }` changes or drops objects of that tag at index time (`docs/API/tag.md:61`); the page is derivable from `o.ref`. Test G, a transform in `CONFIG` for `space-lua` and `space-style` that keeps only `CONFIG` and `Library/…`: after `index.reindexSpace()` no `space-lua` object outside those pages remained (G1); on a fresh runtime the function from the outside page was undefined while `Library/Mine`'s was defined (G3). The transform has to live in `CONFIG` to act during the initial indexing (`docs/API/tag.md:65`). It does nothing to `${…}` expressions: the outside page still rendered `4` (C1 rerun). Test G used the `return {}` variant, which later turned out to drop whole pages from the index; see [index-transform.md](index-transform.md), section 4, for the variant that works and for what the "outside = 0" results here partly mean.

## 7. Anything that restricts code to a folder or a user

**Answer.** Nothing built in. `docs/Security.md`, *What write really means*: "SilverBullet does not offer an in-between 'can edit, but can't script' role within a single space"; the recommended hardening is shell off and one hostname per space (`docs/Security Profiles.md`). The model is per space: `none` / `read` / `write`, admins `write` everywhere, plus the per-user *Runtime API* permission (`docs/Dashboard.md:31-48`, `server/src/multi/config.rs:217-230`). Read members run all scripts too (section 1).

What exists on the client side, none of it enforced: `?disableSpaceLua=1` and `?disableSpaceStyle=1` per browser session (`client/boot.ts:299-310`, `docs/Troubleshooting.md:14-17`); the `renderWidgets = false` page decoration stops widget rendering in the editor only, and it is set by frontmatter (`docs/Page Decorations.md`), so by anyone who can write the page. The one lever that acts by *place* is the index-time transform in `CONFIG` (section 6): it keeps `space-lua` and `space-style` definitions from loading outside chosen pages, and leaves expressions and queries untouched.

Roadmap: nothing in the repository (`CHANGELOG.md` *Edge*: "Nothing yet"; ADRs 001–011 hold no permission model).

## Open points and surprises

* `.html` files served inline on the space origin without CSP (section 3): a second door next to Lua, worth raising upstream.
* `*.plug.js` anywhere in the space loads as a plug (section 3): a write filter on `.md` pages alone does not cover it.
* Scripts are not reloaded after an incremental index (sections 1, 4): a planted `space-lua` block becomes active at the next client boot or reload; for the runtime, at the next fresh runtime or `system.reboot()`.
* The `where` clause (and every other clause) is unrestricted Lua (section 2): a filter that checks expressions has to check query clauses too.
* `space-lua` objects carry no `page` field (section 6); anything that filters them works on `ref`.
* `sync.ignore` in the headless runtime: not tested.
* The runtime here used Chrome for Testing (a full browser): the admin API reported 1.5 GB for it. Not comparable to the 175 MiB per runtime measured with the headless shell in Docker ([architecture.md](../architecture.md), *Cost of a runtime*); not re-measured.
* In a warm runtime, `index.reindexSpace()` followed at once by `system.loadScripts()` left Library functions missing (G2); a second `loadScripts` had them. Reindexing is asynchronous.
* Whether other clients apply the `CONFIG` transform the same way: yes by construction (every client runs `CONFIG` at boot), and confirmed for the browser client in [index-transform.md](index-transform.md), section 3.
