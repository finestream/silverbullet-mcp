# Security model

Status: **proposed** (2026-11-03). This document is the security model of the server: what it defends against, what it assumes about the space, and how each of its parts works. It is kept current with the code; [architecture.md](architecture.md) holds the overall design, [space-guidelines.md](space-guidelines.md) the conventions a guarded space follows, and [facts/](facts/) the measured behaviour of SilverBullet 2.12.1 that this model rests on.

## 1. Threat model

SilverBullet runs code from content. Every `space-lua` block on every page is loaded at client boot and reload; every `${...}` expression and every clause of a `query[[...]]` is Lua, evaluated when the page is shown, transcluded or rendered. It runs in the browser of whoever shows the page, read members included, with that session's full rights (SilverBullet's own [Security](https://silverbullet.md/Security) page, section *What write really means*, says the same). `space-style` blocks are injected into every client. A user who can write *any* page can therefore plant code that reads `CONFIG` or writes anywhere, and it runs the moment someone else opens the page. A path-based access list does not close this: it decides where a user may write, not what the written page may do.

Two more doors are not Markdown: any `*.plug.js` file in the space loads as a plug (a web worker with the user's rights through syscalls) in every client; `.html` files are served inline on the space's origin without a Content Security Policy. SilverBullet 2.12 offers no role that can edit but not script, and nothing that confines code to a folder.

The model below assumes a single-tenant SilverBullet instance whose operator (the person who runs it) is trusted, and guards against every other writer, agents in particular. It does not protect the operator from the operator's own code. The threat model is public on purpose: the protection rests on the design, not on its secrecy.

## 2. The approach

SilverBullet cannot tell a page that *says* something from a page that *does* something, and it cannot be told to. The server therefore makes the distinction itself, by **place**: a few places hold code, every other page is data, and whatever reaches a data page is checked for code. Nothing in the model depends on who wrote a page; it depends only on where the page is.

**The conventions.** Content and code are separated by place, not by author:

* configuration only in `CONFIG`; `CONFIG` is the trusted root, readable by every script, and holds no secret;
* code (Space Lua, Space Style, templates, functions) only in `Library/`;
* every other page is data: text, frontmatter, queries, calls to allowed functions; no function definition, no assignment, no `space-lua`, `space-config` or `space-style` fence; no per-page exception;
* non-page files that execute or are served as code exist only where the operator put them on purpose;
* the space is written through SilverBullet's editor and the MCP server only. This is a strong recommendation, with this rationale: the write filter sees only the server's route; the editor is the operator's route and is covered by the scan; a sync client, a checkout or any other process writing to the space folder is a route nobody checks until the next scan.

The server ships these conventions as [space-guidelines.md](space-guidelines.md), with the defaults that enforce them and what it costs to relax each one.

**The controls.** Five parts enforce the conventions; each covers what the one before it cannot.

1. **The access list** (section 4) says where each user may read, write, delete and render. It keeps the server's users out of `CONFIG` and `Library/` by default, so the places that hold code are written only by the operator. It cannot say what a page may do, which is what the rest is for.
2. **The write filter** (section 5) is the primary control. On every write through the server to a page outside `CONFIG` and `Library/` it parses the page that would result and refuses it if it holds code: a `space-lua`, `space-config` or `space-style` fence, a function definition, an assignment, a call to anything not on the **allowlist** (section 6), a call whose target cannot be known statically. The page never reaches the space. The filter sees only the server's route.
3. **The scan** (section 7) runs the same filter over every page outside `CONFIG` and `Library/` on a schedule, and inventories the files that are not pages. It catches what arrived by any other route: the editor, a sync client, a checkout. In report-only mode (default) the server **refuses to serve** while findings exist (section 9), so the operator sees the problem before an agent works on a space that holds code; in quarantine mode the scan neutralises the findings instead.
4. **The index-time transform** (section 10) is defence in depth, inside SilverBullet itself: a small block in `CONFIG` that strips the code from every `space-lua` and `space-style` object outside `CONFIG` and `Library/` before it is stored in the index, so a block that got past everything else still never loads, in any client, whoever opens the page.
5. **Refuse to serve** (section 9) ties them together: while a control is missing (no transform in `CONFIG`, no valid allowlist) or has findings, the server answers every tool but `list-spaces` with an error that says what to fix.

**What this gives.** A page outside `CONFIG` and `Library/` runs nothing but audited code when opened, transcluded or rendered, whoever wrote it; so a render through the server, which runs with the user's full rights (section 12), is safe to grant. **What it does not give:** `${…}` expressions on a page written directly, outside the server, run until the next scan; a `*.plug.js` or `.html` file placed directly is reported, not disabled; the operator's own code in `CONFIG` and `Library/` is trusted as it is.

## 3. Identity, credentials, authentication

* The server holds, per SilverBullet user, that user's own API token; the client never holds it (no passthrough, see [architecture.md](architecture.md), section 2). A credentials file, loaded from a secret, has one entry per user: API token, default space, groups, and, for clients without OAuth, the hashes of their static bearers (one per client, revocable one by one). One more entry is the technical user of the scan (section 7).
* Clients authenticate with an OAuth token (verified; the user is looked up by `preferred_username`) or a static bearer (looked up by its hash). Both lead to the user's line.
* The server holds no admin token and passes SilverBullet's refusals through: SilverBullet is the ceiling, the server only restricts.

## 4. Access list

* Rights per user or group, space and path: `r` read, `w` create and edit, `d` delete, `x` render, `-` no access.
* A path is the whole space (written `/`), an exact page, or a folder ending in `/`.
* Deny by default: without an entry, nothing is allowed.
* The most specific path wins; on the same path a user entry wins over group entries; between groups `-` wins, otherwise rights add up.
* The list applies to every tool: a denied page is absent from listings and search results.
* Groups are named on the user's line of the credentials file; a user may be in several.
* Shipped default: a group `agents` with `r` on the space, `-` on `CONFIG`, `SETTINGS` and `Library/`, and write rights only where the operator grants them. `SETTINGS` is the configuration page of SilverBullet versions before `CONFIG`; it is kept out for the same reason.

Example:

```
# user-or-group  space    path            rights
@agents          notes    /               r
@agents          notes    CONFIG          -
@agents          notes    SETTINGS        -
@agents          notes    Library/        -
@agents          notes    Shared/         rw
writer-bot       notes    Shared/Bot/     rwdx
writer-bot       notes    Shared/         rwx
```

Here `writer-bot`, a member of `agents`, may render under `Shared/` because its own entry adds `x`, and may delete only in `Shared/Bot/`. The entry for `Shared/Bot/` is the most specific one and replaces the others there, which is why it repeats `x`.

## 5. The write filter

The primary security feature. On every `create-note` and `edit-note` to a page outside `CONFIG` and `Library/` the server parses the *resulting* page and rejects the write, naming the rule and the line, if the page contains:

* a `space-lua`, `space-config` or `space-style` fence (also `~~~`, also with trailing info text, also inside an HTML comment);
* in any `${...}` expression or in any clause of a `query[[...]]` (`where`, `select`, `order by`, `having`, `limit`, `offset`): a function definition (including `order by … using function … end`), an assignment or a `local`;
* a reference to a global name that is not on the allowlist, whether called or passed as a value; query variables and `_CTX` are not global names;
* a call whose callee is not a static dotted name (`a[x](…)`, `f()(…)`, `(expr)(…)`, `("s"):m()`);
* a query or an `index.*` call whose tag argument is not a string literal, or whose literal is `space-lua` or `space-style` (this rule goes beyond the spike of [facts/write-filter.md](facts/write-filter.md) and is not yet tested);
* an expression that does not parse (undecidable, therefore rejected).

A write into `Library/` is possible only where the operator granted `w` there, and is not filtered: that is where code belongs ([space-guidelines.md](space-guidelines.md), *Defaults and overrides*).

**Parser.** The filter is built on SilverBullet's own Lua grammar: four files to be vendored unchanged from [silverbulletmd/silverbullet](https://github.com/silverbulletmd/silverbullet) at tag `2.12.1` (the lezer grammar `lua.grammar`, the generated parser `parse-lua.js` and `parse-lua.terms.js`, and the comment tokenizer `lua_comment.js`), under the MIT licence, credited in the directory they land in and in the README. The spike that tested this carries them already, on its own branch. The rules walk the lezer tree directly. `@lezer/markdown`, the parser SilverBullet builds on, finds fences, code blocks and code spans by CommonMark rules. SilverBullet's directive rule (`${` outside code, then brace balancing; unbalanced is text) is re-implemented in a few lines. A directive body is parsed as `_(<body>)`, as SilverBullet does it. `${` inside a code span, a code block or an indented block is text. Cost measured: 6.9 ms per 50 KB page with 204 directives; a space of a few thousand pages scans in seconds ([facts/write-filter.md](facts/write-filter.md)).

**Stricter than SilverBullet, on purpose:** fences inside HTML comments, directives inside frontmatter and HTML blocks, and unbalanced `${` are all checked or rejected although SilverBullet treats them as inert. A page copied in from elsewhere may be refused for an inert block; the error says so.

**File types.** The server writes only allowlisted file types; shipped default `.md` only. A type SilverBullet executes or serves as code (`*.plug.js`, `.html`, `.lua`) can never be on that list. `render-note` and `screenshot-note` accept pages (`.md`) only; other file types can be read, within the access list, but not rendered.

## 6. The allowlist

* A configuration file of the server, outside the space. It names functions as `name`, `name.*` or `*.method` and governs references, not only calls.
* Every entry is audited by the operator before it is added; code in `Library/` or in a plug is never allowed by virtue of its place.
* Shipped default: `query`, `template.*`, `templates.*`, `index.*`, `views.*`, `string.*`.
* **Allowlist first, never-allowed names as a guard.** The filter's logic is the allowlist alone: a name that is not on it is refused. The never-allowed names below do not add a second decision at filter time; they guard the allowlist itself. When the server validates the file at start, an entry that names one of them or covers one of them (`config.*`, or a bare `*`) makes the file invalid, and the server refuses to serve (section 9). The list is maintained with SilverBullet's releases, as part of the release checks ([README](../README.md), *Status*): a new API that reads, writes, registers code or reaches outside the page goes on it.
* Never allowed, whatever the configuration says: `config.*`, `space.*`, `net.*`, `shell.*`, `js`, `load`, `loadstring`, `dofile`, `require`, `_G`, `rawget`, `rawset`, `rawequal`, `rawlen`, `getmetatable`, `setmetatable`, `os`, `io`, `debug`, `package`, `system`, `editor`, `datastore`, `clientStore`, `event`, `sync`, and the registries `tag.*`, `command.*`, `schema.*`: they take Lua callbacks (an index transform, a command, a validator) and store them in the configuration of whoever views the page, so a data page could register code without a single code fence. Whether a transform registered this way could turn another tag's objects into executable ones is untested; the rule does not depend on it.
* A method on a value is written as a function call (`string.upper(x)`), because the filter cannot know the type of `p.name` in `p.name:upper()`. The format allows an entry such as `*.upper` for operators who want the method form; none is shipped.
* A page that needs more than the list offers calls a function in `Library/` written for that purpose and put on the list after audit. Library functions treat what they receive (arguments, frontmatter, page names) as data.
* The server validates the file at start; an invalid or missing file is a refuse-to-serve condition (section 9).

## 7. The scan

The server runs the filter of section 5 over every page outside `CONFIG` and `Library/`, and inventories every file that is not a page, at start and on a schedule. The interval bounds how long an expression on a directly written page can run before it is found (blocks are already kept from loading by the transform, section 10); the shipped interval is shorter than a typical browser session.

* It runs as a technical SilverBullet user (`scan`), a write member of the space whose token is in the credentials file. It is the server's own deterministic code, not an agent: it does not go through the access list; what it may touch is fixed in code (`CONFIG` and `Library/` never) and configuration.
* **Report-only** (shipped default): findings are written to the report page (section 8) and the log; the server refuses to serve while findings exist (section 9). No page but the report page is changed.
* **Quarantine** (operator choice): a `space-lua`, `space-config` or `space-style` fence becomes a `lua` fence; an offending expression is wrapped in backticks; the page is tagged `#quarantined`. Both neutralisations are inert in SilverBullet and keep the text visible. A quarantine is reversed only by hand; the scan never undoes one.
* Non-page files are reported, never changed. An operator allow entry (a path list beside the allowlist) silences a known file.
* **CLI mode:** the scan also serves installation. It runs once over an existing space before the server goes live, so the operator fixes pages before agents arrive.

## 8. The report page

A page in the space, path configurable, default top-level `MCP Server`, written by `scan`, for the operator to read and act on:

* findings of the last scan: page, line, rule, reason; non-page files outside the allow entries;
* server state: serving or refusing and why; last scan time; allowlist and transform check results;
* statistics: users and spaces seen, request counts per tool, the `(user, space)` runtimes the server has used since its start.

It is overwritten on each run, so it shows the current state. In quarantine mode a query page over `#quarantined` and a periodic notification in SilverBullet repeat the findings until cleared; both are Library code that the operator installs with the transform block (section 10), since the server never writes `CONFIG` or `Library/`.

## 9. Refuse to serve

The server stays up, `list-spaces` and the health endpoint answer, but every other tool call returns a predefined, informative error while any of these holds:

* scan findings exist (report-only mode);
* the index-time transform (section 10) is missing from `CONFIG` or differs from the shipped block;
* the allowlist file is missing or invalid.

The error says what is wrong and what the operator has to do, for example:

```
Refusing to serve: the last scan found 2 pages with code outside Library/.
Operator: read the report page "MCP Server", fix or quarantine the pages, and rerun the scan.
```

The same state is on the report page.

## 10. The index-time transform

Defence in depth. `CONFIG` holds a `tag.define` transform for `space-lua` and `space-style` that keeps the objects of `CONFIG` and `Library/` and replaces the code of every other object with a comment, so a block outside those places is never loaded by any client, whatever route it took into the space. It is a value in the configuration, re-set by `CONFIG` on every script load and applied by the indexer before an object is stored. It survives `System: Reload`, `system.reboot()`, `Space: Reindex`, a headless runtime boot and a fresh browser boot. The Space Overview page shows outside blocks with the replacement text.

```lua
-- Shipped with the MCP server. Keep verbatim; the server checks for it at start.
local function confine(o)
  local page = string.match(o.ref, "^(.*)@%d+$") or ""
  if page == "CONFIG" or string.startsWith(page, "Library/") then return o end
  if o.script then o.script = "-- not loaded: outside CONFIG and Library/" end
  if o.style then o.style = "/* not loaded: outside CONFIG and Library/ */" end
  return o
end
tag.define { name = "space-lua", transform = confine }
tag.define { name = "space-style", transform = confine }
```

Limits and the facts behind it ([facts/index-transform.md](facts/index-transform.md)):

* It is installed by hand: the server never writes `CONFIG`. It takes effect in a client only after a reindex (`Space: Reindex` in every client when it is added to an existing space); until then an index built without it keeps outside scripts and reloads run them.
* It does not touch `${...}` expressions; those are the filter's and the scan's job.
* `CONFIG`'s own objects cannot be dropped: the loader clears the configuration and rebuilds it from the index, so without `CONFIG@…` in the index every `config.set`, schema, command and function of `CONFIG` is lost after the first reload. `CONFIG`'s source therefore stays queryable by trusted code, which is why `CONFIG` holds no secret and why agent pages may not query the `space-lua` tag.
* A transform that *removes* outside objects (`return {}`) is defective in 2.12.1: the indexer takes the empty Lua table as an object without `ref`, throws, and drops the whole page from the index (links and tasks included). The block above keeps the object.
* The transform touches the index of every page; it is changed like code, with tests, not like configuration.
* The `space-lua` half is measured (reloads, reindex, headless and browser boot); the `space-style` half follows from the same code path and is not yet measured.

## 11. Shipped defaults and warnings

The defaults the server ships with, what each protects, how it can be relaxed and the risk that relaxing it accepts are in [space-guidelines.md](space-guidelines.md), *Defaults and overrides*, next to the rules they enforce. What stays here is the mechanism: the server validates its configuration at start; a setting weaker than the default is accepted and reported once, in the log and on the report page (section 8), so that a relaxed posture is always visible; the never-allowed names (section 6) and the transform check (section 9) cannot be switched off.

## 12. Rendering

A render runs with the user's full SilverBullet rights for reading and writing; it is safe to grant `x` because pages hold no code (sections 5, 7, 10). The server's blocking of write functions during a render is best-effort ([architecture.md](architecture.md), *Runtime identity*). `render-note` returns no `revision`; `edit-note` requires one, so every edit is based on the source that `read-note` returns.

After a write, a render waits, bounded, until the runtime's index holds the new revision; if it does not arrive, the server reboots the runtime's client (`system.reboot()` through the Runtime API, as the same user), which re-indexes the space. The headless runtime was seen to lag behind the browser client in picking up writes ([facts/index-transform.md](facts/index-transform.md), *Open points*). The server cannot start or stop runtimes itself ([architecture.md](architecture.md), section 5).

## 13. Alternatives rejected

| Alternative | Why rejected |
|---|---|
| Refuse `x` where the same user has `w` | Closes the agent-triggered render, leaves the operator's browser open: the code still runs when the operator opens the page. |
| A deny list of dangerous functions as the decision | Names can be built at run time (`_G["sp".."ace"]`); only an allowlist with a rule against dynamic calls holds. The never-allowed names of section 6 guard the allowlist; they are not the decision. |
| Every function in `Library/` allowed | Trusts plugs and imported libraries by default. |
| The allowlist as a page in the space | As writable as any file, and the list is the critical part of the model. |
| Dropping `CONFIG`'s objects from the index | Breaks the configuration after the first reload (section 10). |
| The `return {}` transform | Drops whole pages from the index (section 10). |
| The scan as a separate container | More to configure and more to go wrong, for code that is the server's own. |
| Per-page exceptions by tag | The tag is writable by whoever writes the page. |
| Renaming or deleting foreign files | Invasive; a report and an allow entry suffice. |
