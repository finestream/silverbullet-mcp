# Security model

Status: **proposed** (2026-11-03, revised 2026-11-04 with the core server and the render tools). This document is the security model of the server: what it defends against, what it assumes about the space, and how each of its parts works. It is kept current with the code; [architecture.md](architecture.md) holds the overall design, [space-guidelines.md](space-guidelines.md) the conventions a guarded space follows, and [facts/](facts/) the measured behaviour of SilverBullet 2.12.1 that this model rests on.

## 1. Threat model

SilverBullet runs code from content. Every `space-lua` block on every page is loaded at client boot and reload; every `${...}` expression and every clause of a `query[[...]]` is Lua, evaluated when the page is shown, transcluded or rendered. It runs in the browser of the person who shows the page, read members included, with that person's full rights (SilverBullet's own [Security](https://silverbullet.md/Security) page, section *What write really means*, says the same). `space-style` blocks are injected into every client. An agent that can write *any* page can therefore plant code that reads `CONFIG` or writes anywhere, and it runs the moment a person opens the page. A path-based access list does not close this: it decides where an agent may write, not what the written page may do.

Two more doors are not Markdown: any `*.plug.js` file in the space loads as a plug (a web worker that acts, through syscalls, with the rights of the person whose browser loaded it) in every client; `.html` files are served inline on the space's origin without a Content Security Policy. SilverBullet 2.12 offers no role that can edit but not script, and nothing that confines code to a folder.

The model below assumes a single-tenant SilverBullet instance whose operator is trusted, and guards against every other writer, agents in particular. It does not protect the operator from the operator's own code. The threat model is public on purpose: the protection rests on the design, not on its secrecy.

**Terms.** A **user** is a SilverBullet account with its own API token, which is what the access list and the credentials file know. Behind a user is a **person**, who works in SilverBullet's editor in a browser; an **agent**, an AI that reaches the space through this server; or a **technical user**, the scan (section 7). A person may also drive an MCP client; towards the server that identity is an agent. The **operator** is the person who runs the instance, holds SilverBullet's admin role and configures the server. A **client** is the program that holds an agent's bearer and speaks MCP to the server.

## 2. The approach

SilverBullet cannot tell a page that *says* something from a page that *does* something, and it cannot be told to. The server therefore makes the distinction itself, by **place**: a few places hold code, every other page is data, and whatever reaches a data page is checked for code. Nothing in the model depends on who wrote a page; it depends only on where the page is.

**The conventions.** Content and code are separated by place, not by author:

* configuration only in `CONFIG`; `CONFIG` is the trusted root, readable by every script, and holds no secret;
* code (Space Lua, Space Style, templates, functions) only in `Library/`;
* every other page is data: text, frontmatter, queries, calls to allowed functions; no function definition, no assignment, no `space-lua`, `space-config` or `space-style` fence; no per-page exception;
* non-page files that execute or are served as code exist only where the operator put them on purpose;
* the space is written through SilverBullet's editor and the MCP server only. This is a strong recommendation, with this rationale: the write filter sees only the server's route, that is, agents; the editor is the persons' route and is covered by the scan; a sync client, a checkout or any other process writing to the space folder is a route nobody checks until the next scan.

The server ships these conventions as [space-guidelines.md](space-guidelines.md), with the defaults that enforce them and what it costs to relax each one.

**The controls.** Five parts enforce the conventions; each covers what the one before it cannot.

1. **The access list** (section 4) says where each agent may read, write, delete and render. Its entries are per user or group, but it binds only the server's route: a person in SilverBullet's editor has SilverBullet's rights, untouched. It keeps agents out of `CONFIG` and `Library/` by default, so the places that hold code are written only by persons, the operator above all. It cannot say what a page may do, which is what the rest is for.
2. **The write filter** (section 5) is the primary control. On every write through the server to a page outside `CONFIG` and `Library/` it parses the page that would result and refuses it if it holds code: a `space-lua`, `space-config` or `space-style` fence, a function definition, an assignment, a call to anything not on the **allowlist** (section 6), a call whose target cannot be known statically. The page never reaches the space. The filter sees only the server's route.
3. **The scan** (section 7) runs the same filter over every page outside `CONFIG` and `Library/` on a schedule, and inventories the files that are not pages. It catches what arrived by any other route: the editor, a sync client, a checkout. In report-only mode (default) its findings **block rendering in that space** until the operator has looked: agents keep reading and writing, and a cleaned page passes the filter; in quarantine mode the scan neutralises the findings instead.
4. **The index-time transform** (section 10) is defence in depth, inside SilverBullet itself: a small block in `CONFIG` that strips the code from every `space-lua` and `space-style` object outside `CONFIG` and `Library/` before it is stored in the index, so a block that got past everything else still never loads, in any client, whichever person opens the page.
5. **Refuse to serve** (section 9) ties them together: while a control is missing (no valid allowlist, no transform in `CONFIG`, a space the scan cannot reach), the server answers every tool but `list-spaces` with an error that says what to fix.

**What this gives.** A page outside `CONFIG` and `Library/` runs nothing but audited code when opened, transcluded or rendered, whoever wrote it; so a render through the server, which runs with the full rights of the agent's user (section 12), is safe to grant. **What it does not give:** `${…}` expressions on a page written directly, outside the server, run until the next scan, and renders in that space are refused from then on; a `*.plug.js` or `.html` file placed directly is reported, not disabled; the operator's own code in `CONFIG` and `Library/` is trusted as it is.

## 3. Identity, credentials, authentication

* The server holds, per SilverBullet user, that user's own API token; the client never holds it (no passthrough, see [architecture.md](architecture.md), section 2). A credentials file, loaded from a secret and re-read when it changes, has one line per user: API token, default space, groups, and, for clients without OAuth, the SHA-256 hashes of their static bearers (one per client, revocable one by one; format in [`config/credentials.example`](../config/credentials.example)). One more line is the technical user of the scan (section 7), named by `MCP_SCAN_USER` (default `scan`).
* Clients authenticate with an OAuth token (verified; the user is looked up by `preferred_username`) or a static bearer (sent in the `Authorization` header only, looked up by its hash with a constant-time comparison). Both lead to the user's line. A user is limited to a number of tool calls per minute (shipped: 120); an address that keeps sending refused bearers is limited too; a request body is at most 4 MB. A regular expression an agent supplies to `search-notes` or as a `namePattern` is matched in a worker thread with a time limit, so a pattern that backtracks catastrophically is refused instead of blocking the server.
* The server holds no admin token and passes SilverBullet's refusals through: SilverBullet is the ceiling, the server only restricts.

## 4. Access list

* Rights per user or group, space and path: `r` read, `w` create and edit, `d` delete, `x` render, `-` no access. The list restricts agents only: it is checked on the server's route and nowhere else; a person in SilverBullet's editor is bound by SilverBullet's own rights.
* A path is the whole space (written `/`), an exact page, or a folder ending in `/`. A file that is not a page is matched by its file name (`Pictures/a.png`). The space is a prefix, or `*` for every space.
* Deny by default: without an entry, nothing is allowed.
* The most specific path wins; on the same path a user entry wins over group entries; between groups `-` wins, otherwise rights add up.
* The list applies to every tool: a denied page is absent from listings and search results.
* **`x` is not a Unix permission.** Unix checks every file a program opens against the user's rights. The access list is checked only at the tool boundary, when a call arrives; a render (`x`) then runs inside SilverBullet with the user's full rights in that space, and what the page transcludes or queries is not checked against the list. A `-` on `CONFIG` keeps `read-note` out of `CONFIG`; it does not hold inside a render of a page that transcludes `CONFIG` (section 12). The closer analogy is a restricted shell that can start a program running with the user's full rights: `x` means "may read everything SilverBullet lets this user read in that space", and is granted with that in mind.
* Groups are named on the user's line of the credentials file; a user may be in several.
* Shipped default: a group `agents` with `r` on the space, `-` on `CONFIG`, `SETTINGS` and `Library/`, and write rights only where the operator grants them. `SETTINGS` is the configuration page of SilverBullet versions before `CONFIG`; it is kept out for the same reason. The file is re-read when it changes ([`config/access-list.example`](../config/access-list.example)).

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
* in any `${...}` expression or in any clause of a `query[[...]]` (`where`, `select`, `order by`, `group by`, `having`, `limit`, `offset`): a function definition (including `order by … using function … end`), an assignment or a `local`;
* a reference to a global name that is not on the allowlist, whether called or passed as a value. Not global names: `_CTX`, the variables a query binds (`from p = …`, and `key` and `group` under `group by`), and the query aggregates `count`, `sum`, `min`, `max`, `avg` and `array_agg`, which are the query engine's own;
* a query whose source has no name (`from index.tag "page" where status == "active"`): SilverBullet then makes every field of the row a bare variable that shadows globals, so the filter could not tell a field from a global function passed as a value. The row is named (`from p = index.tag "page" where p.status == "active"`), which SilverBullet recommends anyway;
* a baked section `<!--#lua EXPR -->` whose expression breaks any of these rules, wherever the marker sits, code blocks and code spans included: a person's *Baked Sections: Update* finds the markers with a regular expression on the raw page text and re-evaluates every expression with that person's rights, so the expression is checked like a directive;
* a page with so many unclosed `${` that balancing them would take more than a bounded number of steps (SilverBullet's own parser is quadratic there), or a page longer than 1,000,000 characters;
* a call whose callee is not a static dotted name (`a[x](…)`, `f()(…)`, `(expr)(…)`, `("s"):m()`), and a method call on a value whose type the filter cannot know (`p.name:upper()`), unless a `*.method` entry admits that method;
* a query or an `index.*` call whose tag argument is not a string literal, or whose literal is `space-lua` or `space-style`: the first argument of `index.tag`, `index.objects`, `index.contentPages`, `index.pages` and `index.queryLuaObjects`, the second of `index.getObjectByRef`;
* an expression that does not parse (undecidable, therefore rejected).

The refusal names every rule and line found, and nothing is written. The same filter checks the page that results from an `edit-note`, not the edit alone. Before any of this, a file name with an empty, `.`, `..` or dot-prefixed segment, a backslash or a control character is refused, as is a space name that is not letters, digits, `_` and `-`.

A write into `Library/` is possible only where the operator granted `w` there, and is not filtered: that is where code belongs ([space-guidelines.md](space-guidelines.md), *Defaults and overrides*).

**Parser.** The filter is built on SilverBullet's own Lua grammar: four files vendored unchanged from [silverbulletmd/silverbullet](https://github.com/silverbulletmd/silverbullet) at tag `2.12.1` (the lezer grammar `lua.grammar`, the generated parser `parse-lua.js` and `parse-lua.terms.js`, and the comment tokenizer `lua_comment.js`), under the MIT licence, with its licence file beside them and credited in the README; in [`src/filter/vendor/silverbullet/`](../src/filter/vendor/silverbullet/), where the release checks compare them with the upstream tag. The rules walk the lezer tree directly. `@lezer/markdown`, the parser SilverBullet builds on, finds fences, code blocks and code spans by CommonMark rules. SilverBullet's directive rule (`${` outside code, then brace balancing; unbalanced is text) is re-implemented in a few lines. A directive body is parsed as `_(<body>)`, as SilverBullet does it. `${` inside a code span, a code block or an indented block is text. Cost measured: 6.9 ms per 50 KB page with 204 directives; a space of a few thousand pages scans in seconds ([facts/write-filter.md](facts/write-filter.md)).

**Stricter than SilverBullet, on purpose:** fences inside HTML comments, directives inside frontmatter and HTML blocks, and unbalanced `${` are all checked or rejected although SilverBullet treats them as inert. A page copied in from elsewhere may be refused for an inert block; the error says so.

**File types.** The server writes only allowlisted file types (`MCP_FILE_TYPES`); shipped default `.md` only. A type SilverBullet executes or serves as code (`*.plug.js`, `.js`, `.html`, `.svg`, `.lua` and their variants) can never be on that list: a configuration that names one is invalid and the server refuses to serve (section 9). `render-note` and `screenshot-note` accept pages (`.md`) only; other file types can be read, within the access list, but not rendered.

## 6. The allowlist

* A configuration file of the server, outside the space. It names functions as `name`, `name.*` or `*.method` and governs references, not only calls.
* Every entry is audited by the operator before it is added; code in `Library/` or in a plug is never allowed by virtue of its place.
* Shipped default ([`config/allowlist`](../config/allowlist)): `query`, `template.each`, `templates.*`, `string.*`, and the `index.*` functions that read (`index.tag`, `index.objects`, `index.pages`, `index.items`, … by name). Not `template.*` as a whole: `template.new` evaluates the `${…}` directives of its string argument, so `template.each({1}, template.new("${space.readPage('CONFIG')}"))` would pass a filter that checks only the calls. Not `index.*` as a whole: `index.indexObjects`, `index.deleteObject`, `index.patchFrontmatter`, `index.defineTag` and `index.reindexSpace` write the index or a page, or register a tag transform, and `index.queryLuaObjects` takes a query as a table whose clauses are Lua syntax trees, which is code as data.
* **Allowlist first, never-allowed names as a guard.** The filter's logic is the allowlist alone: a name that is not on it is refused. The never-allowed names below do not add a second decision at filter time; they guard the allowlist itself. When the server validates the file at start, an entry that names one of them or covers one of them (`config.*`, or a bare `*`) makes the file invalid, and the server refuses to serve (section 9). The list is maintained with SilverBullet's releases, as part of the release checks ([`test/checks/08-api.test.ts`](../test/checks/08-api.test.ts)): every global of the release's Lua environment must be on the never-allowed list, on the list of reviewed harmless globals, or defined by the fixtures, so a new API is noticed; one that reads, writes, registers code or reaches outside the page goes on the never-allowed list.
* Never allowed, whatever the configuration says (`NEVER_ALLOWED` in [`src/filter/allowlist.ts`](../src/filter/allowlist.ts)): a bare name covers the whole namespace (`space` covers `space.readPage`), a dotted name one function (`template.new`). The names, with the reason per namespace and the members reviewed one by one, are in the table below.
* **Exceptions by exact name.** A member of a never-allowed namespace that only reads the clock, builds a plain table or reports a fact about the client may be put on the allowlist by its exact name (`os.date`), if it is on the reviewed list (`REVIEWED_MEMBERS` in the same file; the table below). The rule is narrow on purpose: a wildcard under a never-allowed name (`os.*`) makes the file invalid, a `*.method` entry never reaches under one (`*.date` does not admit `os.date`), and an exact entry naming a member that is not on the reviewed list (`os.getenv`, `markdown.expandMarkdown`) makes the file invalid too, so the server refuses to serve (section 9) rather than guess. The shipped allowlist adds none of them; an operator who adds one sees it reported as a setting weaker than the default (section 11). The write filter and the scan apply the same compiled list, so a page using `os.date` passes both once the entry is there; without it the refusal names the rule (`denied-name: os.date`) and says that an exact entry would admit the member. The reviewed list is maintained with the never-allowed list: the release checks assert that every reviewed member still exists and behaves as reviewed on the running SilverBullet release.
* A method on a value is written as a function call (`string.upper(x)`), because the filter cannot know the type of `p.name` in `p.name:upper()`. The format allows an entry such as `*.upper` for an operator who wants the method form; none is shipped. A `*.method` entry is invalid when a never-allowed function ends in that method (`*.new` would admit `template.new`).
* No library's name is shipped. A space whose pages call a library (a page footer such as `mylib.views.page(...)`) gets that library's entry (`mylib.views.*`) from its operator, after audit; a global that merely exists in a space is not allowed by default.
* A page that needs more than the list offers calls a function in `Library/` written for that purpose and put on the list after audit. Library functions treat what they receive (arguments, frontmatter, page names) as data.
* The server validates the file at start and whenever it changes; an invalid or missing file is a refuse-to-serve condition (section 9).

Reviewed against SilverBullet 2.12.1 (`client/space_lua/stdlib/`, `client/space_lua_api.ts`, which exposes every registered syscall as a Lua global, and `libraries/Library/Std/`, the standard library's own Lua):

| Never allowed | Why | Members allowable by exact entry |
|---|---|---|
| `load`, `loadstring`, `dofile`, `require` | compile or run code from a string or a file (`loadstring` and `require` do not exist in 2.12.1; kept) | none |
| `_G`, `rawget`, `rawset`, `rawequal`, `rawlen`, `getmetatable`, `setmetatable` | reach any global by a computed name; change how a table behaves | none |
| `os` | Lua's operating-system library | `os.date`, `os.time`, `os.difftime`, `os.clock`: the whole namespace in 2.12.1; every member reads or formats the clock, with no argument that names anything |
| `io`, `debug`, `package` | Lua's file, debug and module libraries; do not exist in 2.12.1, kept against a release that adds them | none |
| `space` | reads, writes and deletes pages, documents and files; revisions, git | none: every member reaches beyond the page |
| `config` | the configuration, which holds what the operator put there; `set`, `insert`, `define` register | none |
| `net`, `http`, `sandboxFetch` | the network (`net.proxyFetch`, `net.readURI`, `net.writeURI`, `http.request`, `sandboxFetch.fetch`) | none |
| `shell` | runs a command on the server | none |
| `js` | the browser's JavaScript world (`js.window`, `js.import`, `js.new`) | none |
| `system` | invokes functions and commands, reboots, loads plugs, wipes the client | `system.getVersion`, `system.getMode`, `system.getBaseURI`, `system.getURLPrefix`: a fact about the client |
| `editor` | edits text, moves the cursor, navigates, prompts, uploads and downloads | `editor.getCurrentPage`, `editor.getCurrentPageMeta`, `editor.getCurrentPath`, `editor.isMobile`, `editor.isNarrowScreen`: facts about the page being shown and the client |
| `datastore`, `clientStore` | the key-value stores of the index and of the browser; `datastore.queryLua` takes a query as data | none |
| `event`, `mq`, `sync` | dispatch events, send to queues, run a sync | none |
| `asset` | reads plug assets: beyond the page | none |
| `widget`, `codeWidget`, `dom` | inject HTML and scripts into the page shown (`widget.html`; `widget.sandbox` runs a script; `dom` builds live DOM through `js.window.document`); `codeWidget.define` registers | none |
| `spacelua` | `evalExpression` and `interpolate` evaluate strings; `describe` and `listFunctions` reflect over every global | `spacelua.baseUrl`: the client's base URL |
| `lua` | `lua.evalExpression` evaluates a string with the full environment | none (`parse*` and `prettyPrint*` are pure, but no page needs them) |
| `service` | `define` registers a callback; `invoke`, `invokeBestMatch` run one | none |
| `capture` | `saveFile` writes a file | none |
| `view`, `navigator` | open and define navigator views: UI and a registry | none |
| `github` | network calls with a token from the configuration | none |
| `share` | writes frontmatter and shares a page | none |
| `journal.openOrCreate` | creates a page and navigates (`journal.entries` and `journal.neighbor` read the index and are not under it) | — |
| `embed` | returns an iframe pointing at a URL given as data | none |
| `tag`, `command`, `slashCommand`, `slashcommand`, `aggregate`, `actionButton`, `keyboardBar`, `syntax`, `taskState`, `virtualPage`, `identity.define`, `toggleReadOnlyMode` | registries: they store Lua callbacks (an index transform, a command, an aggregate, a syntax, a virtual page, a validator) in the configuration of the client that shows the page, a person's browser or an agent's render runtime, so a data page could register code without a single code fence; `toggleReadOnlyMode` changes the editor. Whether a transform registered this way could turn another tag's objects into executable ones is untested; the rule does not depend on it | none |
| `schema` | every member of 2.12.1 is a constructor returning a plain table; the name stays never allowed because it is a registry's name and a future `schema.define` would otherwise be admitted by `schema.*` | all ten: `schema.string`, `schema.number`, `schema.boolean`, `schema.array`, `schema.nullable`, `schema.nullableArray`, `schema.func`, `schema.schema`, `schema.object`, `schema.null` |
| `template.new`, `template.fromPage`, `template.createPageFromTemplate` | evaluate the `${…}` directives of a string; read a page named by the argument and evaluate it; write a page (`template.each` is not under them and is shipped) | — |
| `markdown` | `expandMarkdown`, and `markdownToHtml` with its `expand` option, evaluate directives; `bakeSections` re-evaluates baked sections | `markdown.parseMarkdown`, `markdown.renderParseTree`: parse to a tree and print it back, without evaluation |
| `index.indexObjects`, `index.deleteObject`, `index.defineTag`, `index.patchFrontmatter`, `index.reindexSpace`, `index.ensureFullIndex`, `index.clearFileIndex`, `index.queryLuaObjects` | write the index or a page, register a tag; `queryLuaObjects` takes a query as a table whose clauses are Lua syntax trees, code as data (the reading `index.*` functions are not under them and are shipped by name; `index.validateObjects` and `index.previewProcessedObjects` of 2.12.1 run the indexing pipeline on given objects without writing: not never allowed, not shipped) | — |

Globals of 2.12.1 that are on neither list, and that an operator may add after audit: plain Lua (`math`, `table`, `tonumber`, `tostring`, `type`, `select`, `next`, `pairs`, `ipairs`, `each`, `some`, `print`, `assert`, `error`, `pcall`, `xpcall`), the pure libraries `encoding`, `crypto`, `yaml`, `jsonschema`, `language`, `icon`, `search`, the standard library's `date` (`today`, `tomorrow`, `yesterday`, `time`, built on `os.date`), `tags` (a table whose fields are `index.objects` of that tag), `templates` and `widgets` (what libraries define), `identity.mentions`, `identity.own`, `journal.entries`, `journal.neighbor`, `formatMarkdownTable` and `nodeParentOfType`. The release checks keep this classification complete: a global that is on none of the three lists fails the check until it is reviewed.

## 7. The scan

The server runs the filter of section 5 over every page outside `CONFIG` and `Library/`, and inventories every file that is not a page, at start (before it listens), on a schedule (`MCP_SCAN_INTERVAL`, shipped 15 minutes), on `SIGHUP`, and as a one-off run (`--scan`). The interval bounds how long an expression on a directly written page can run before it is found (blocks are already kept from loading by the transform, section 10); the shipped interval is shorter than a typical browser session.

* It runs as a technical SilverBullet user (`scan` unless `MCP_SCAN_USER` names another), a write member of the space whose token is in the credentials file. It is the server's own deterministic code, not an agent: it does not go through the access list; what it may touch is fixed in code (`CONFIG` and `Library/` never) and configuration. The spaces it scans are every space prefix the instance lists that `scan` can reach, or the list in `MCP_SPACES`; a space `scan` cannot reach as a write member is **unguarded**, and the server refuses to serve it (section 9).
* The scan also checks that `CONFIG` holds the transform block of section 10 verbatim, per space.
* **Report-only** (shipped default): findings are written to the report page (section 8) and the log, and **rendering is refused in that whole space** while they exist: `render-note` and `screenshot-note` answer with the error that names the findings, `read` and `write` stay available, so an agent can help clean up. Its edits still pass the write filter, so a cleaned page is accepted and a page that still holds code is refused; a write through the server that passes the filter drops that page's findings at once, and the next scan refreshes the report page. Per space, not per page: a clean page can transclude or query a page with findings and run its code. No page but the report page is changed.
* **Quarantine** (operator choice): a `space-lua`, `space-config` or `space-style` fence becomes a `lua` fence; an offending expression is wrapped in backticks (a fenced block when it spans a blank line); a baked marker loses its `#`; the page is tagged `#quarantined`. The neutralisations are inert in SilverBullet and keep the text visible; the scan checks the neutralised page with the filter before writing it, and leaves it a finding otherwise. A quarantine is reversed only by hand; the scan never undoes one.
* Non-page files outside `CONFIG` and `Library/` are reported, never changed, and block rendering like a finding. An operator allow entry ([`config/allowed-files.example`](../config/allowed-files.example): a file or a folder per space) silences a known file.
* **CLI mode:** the scan also serves installation. It runs once over an existing space before the server goes live, so the operator fixes pages before agents arrive.

## 8. The report page

A page in every guarded space, path configurable (`MCP_REPORT_PAGE`), default top-level `MCP Server`, written by the technical user, for the operator to read and act on:

* findings of the last scan: page, line, rule, reason; non-page files outside the allow entries; pages quarantined in that run;
* server state: serving or refusing and why; rendering available or blocked; last scan time; allowlist and transform check results; settings weaker than the shipped defaults (section 11);
* statistics: users and spaces seen, request counts per tool and refusals per control since the server's start, and the `(user, space)` runtimes the server has used in that space since its start, with first and last use, calls and reboots (section 12).

Every detail on the page is in a code span, a page name is linked only when it holds nothing but letters, digits, spaces and a few punctuation marks, and the rendered page is checked with the filter before it is written: if a name or a detail would still make a directive, a fence or a baked marker, the whole report goes into one fenced block that nothing inside can close. The report page cannot be written or deleted through the tools.

It is overwritten on each run, so it shows the current state. In quarantine mode a query page over `#quarantined` and a periodic notification in SilverBullet repeat the findings until cleared; both are Library code that the operator installs with the transform block (section 10), since the server never writes `CONFIG` or `Library/`.

## 9. Refuse to serve

The server stays up, `list-spaces` and the health endpoint (`/healthz`) answer, but every other tool call returns a predefined, informative error while any of these holds:

* for the whole server: the allowlist file is missing or invalid (section 6), the access list file is missing or has a malformed line (a dropped line could have been a denial, so the list is applied whole or not at all), or the configured file types name a type that executes (section 5);
* for one space: the index-time transform (section 10) is missing from its `CONFIG` or differs from the shipped block, or the space is unguarded because the technical user cannot reach it as a write member (section 7).

Scan findings are not a refuse-to-serve condition: they block rendering in that space (section 7). The error says what is wrong and what the operator has to do, for example:

```
Refusing to serve space "notes": the index-time transform is missing from CONFIG or differs
from the shipped block. Operator: add the block of docs/security.md, section 10, to CONFIG
verbatim and run "Space: Reindex" in every client; the server re-checks on the next scan or SIGHUP.
```

The same state is on the report page; `/healthz`, which answers without a bearer, says only whether the server can serve (200 or 503) and names no space.

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
* `CONFIG`'s own objects cannot be dropped: the loader clears the configuration and rebuilds it from the index, so without `CONFIG@…` in the index every `config.set`, schema, command and function of `CONFIG` is lost after the first reload. `CONFIG`'s source therefore stays queryable by trusted code, which is why `CONFIG` holds no secret and why pages written by agents may not query the `space-lua` tag.
* A transform that *removes* outside objects (`return {}`) is defective in 2.12.1: the indexer takes the empty Lua table as an object without `ref`, throws, and drops the whole page from the index (links and tasks included). The block above keeps the object.
* The transform touches the index of every page; it is changed like code, with tests, not like configuration.
* The `space-lua` half is measured (reloads, reindex, headless and browser boot); the `space-style` half follows from the same code path and is not yet measured.

## 11. Shipped defaults and warnings

The defaults the server ships with, what each protects, how it can be relaxed and the risk that relaxing it accepts are in [space-guidelines.md](space-guidelines.md), *Defaults and overrides*, next to the rules they enforce. What stays here is the mechanism: the server validates its configuration at start; a setting weaker than the default is accepted and reported once, in the log and on the report page (section 8), so that a relaxed posture is always visible; the never-allowed names (section 6) and the transform check (section 9) cannot be switched off.

## 12. Rendering

`render-note` and `screenshot-note` run SilverBullet's Runtime API as the calling user, so the runtime is that user's, for that space, with that user's full SilverBullet rights, for reading and writing. It is safe to grant `x` because pages hold no code (sections 5, 7, 10), which is why a render is refused in a space whose last scan has findings (section 7). The server's blocking of the writing functions of `space` during a render is best-effort ([architecture.md](architecture.md), *Runtime identity*). Both tools need `x` on the page, and `x` alone: a render shows transcluded and queried pages whatever the access list says about them, because the list binds the MCP route only (section 4) and the Lua of the page runs inside SilverBullet. **`x` is therefore not a Unix permission** (section 4): Unix checks every file a program opens, the access list checks only the call at the tool boundary, and a `-` in the list does not hold inside a render. The analogy is a restricted shell that can start a program with the user's full rights. Measured on 2.12.1: a user with `w` and `x` on a folder and `-` on `CONFIG` writes a page there that holds only `![[CONFIG]]`, and `render-note` returns `CONFIG`'s source; the write filter does not object, because a transclusion is not code. Granting `x` means granting a read of everything SilverBullet lets that user read in the space; `CONFIG` holds no secret for the same reason (section 2). They render pages (`.md`) only. `render-note` returns no `revision`; `edit-note` requires one, so every edit is based on the source that `read-note` returns. The refusals are explicit: no `x` (the access list), the Runtime API not granted or a read-only member (SilverBullet's `403`, passed through with the hint that rendering needs Write and the Runtime API granted in the space's access grid), rendering blocked by scan findings (with the report page), another file type, SilverBullet's `404` for a missing page.

**After a write.** Every page created, edited or deleted through the server is recorded per space. Before a render, the pages that runtime has not yet confirmed are checked in its index: the page object's `lastModified` is compared with the file's, both as the client formats them, and a deleted page must have no object. The server waits, bounded (`MCP_INDEX_WAIT`, shipped 5 s), then reboots the runtime's client (`system.reboot()` through the Runtime API, as the same user), which re-indexes the space, and checks once more. A page still missing after that is a warning on the result, not an error, and is not retried on the next render (one reboot per batch of writes). The headless runtime was seen to lag behind the browser client in picking up writes ([facts/index-transform.md](facts/index-transform.md), *Open points*); on the test instance it lags by about a second. The server cannot start or stop runtimes itself ([architecture.md](architecture.md), section 5); one queue per `(user, space)` serialises the calls on a runtime, a global cap and a deadline per call bound them.

## 13. Alternatives rejected

| Alternative | Why rejected |
|---|---|
| Refuse `x` where the same user has `w` | Closes the agent-triggered render, leaves every person's browser open: the code still runs when a person opens the page. |
| A deny list of dangerous functions as the decision | Names can be built at run time (`_G["sp".."ace"]`); only an allowlist with a rule against dynamic calls holds. The never-allowed names of section 6 guard the allowlist; they are not the decision. |
| Every function in `Library/` allowed | Trusts plugs and imported libraries by default. |
| The allowlist as a page in the space | As writable as any file, and the list is the critical part of the model. |
| Dropping `CONFIG`'s objects from the index | Breaks the configuration after the first reload (section 10). |
| The `return {}` transform | Drops whole pages from the index (section 10). |
| The scan as a separate container | More to configure and more to go wrong, for code that is the server's own. |
| Refuse to serve on scan findings (the first version of this model) | It would also stop the agent that could clean the page. Findings open one door, code that runs when the page is rendered; refusing rendering in that space closes it and keeps read and write (2026-11-03). |
| Refuse rendering per page with findings | A clean page can transclude or query a page with findings and run its code; the block is per space (2026-11-03). |
| `template.*` and `index.*` whole on the shipped allowlist | `template.new` evaluates its string argument; `index.indexObjects`, `index.defineTag` and their kin write the index or register a transform. Shipped by name instead (2026-11-04). |
| Per-page exceptions by tag | The tag is writable by whoever writes the page. |
| Renaming or deleting foreign files | Invasive; a report and an allow entry suffice. |
