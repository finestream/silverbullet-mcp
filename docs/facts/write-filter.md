# Facts: a write filter on SilverBullet's Lua parser

Can the server reject a page that carries code it should not carry, using SilverBullet's own Lua parser instead of a regex? Answered with throw-away code under `spike/write-filter/` (`filter.ts`, `cases.ts`, `run.ts`, `bench.ts`, `vendor/silverbullet/`; on a branch of its own until the server's filter replaces it), SilverBullet source at tag `2.12.1`, the npm registry as of 2026-11-03, Node 26 on Apple silicon.

## 1. Can SilverBullet's Lua parser be imported?

**Answer.** Not from the npm package; yes by copying four files. The parser is a lezer grammar (`client/space_lua/lua.grammar`, based on R167/lezer-lua) compiled to `parse-lua.js` (19 KB) with `parse-lua.terms.js` and an external comment tokenizer `lua_comment.js`. Runtime dependencies: `@lezer/lr` and `@lezer/common` only. Copied unchanged into `spike/write-filter/vendor/silverbullet/` with SilverBullet's `LICENSE.md` (MIT); the attribution is in the spike's README.

Evidence:

* `@silverbulletmd/silverbullet` on npm: latest `2.12.0`; its `files` list (`package.json:43-58` at 2.12.1) ships `client/space_lua/**/*.ts` but no `.js`, so `parse-lua.js`, `parse-lua.terms.js` and `lua_comment.js` are missing from the installed package (checked: `node_modules/@silverbulletmd/silverbullet/client/space_lua/` has `parse.ts` but no `parse-lua.js`). `parse.ts` also imports `client/markdown_parser/parse_tree.ts`, which is not shipped either (only `constants.ts` is). The package's `exports` map (`package.json:9-41`) exposes `plug-api` paths only; no sub-path reaches the parser.
* `parse.ts` (SilverBullet's conversion of the lezer tree into its own AST, 1 869 lines) pulls in `runtime.ts` (1 886 lines, which pulls `eval.ts` and the standard library), `error_hints.ts`, `labels.ts`, `@lezer/highlight` and `@codemirror/language`. Not needed: the filter walks the lezer tree directly, which has every node the rules need (`FunctionCall`, `Property`, `MemberExpression`, `FunctionDef`, `FuncBody`, `Assign`, `Local`, `Query`, `WhereClause`, `Name`; see `lua.grammar`).
* Licence: MIT (`LICENSE.md`, Zef Hemel 2022); attribution required, nothing else. The generated file keeps its header.
* Size and build: pure ESM JavaScript, no build step; `node_modules` for `@lezer/lr`, `@lezer/common`, `@lezer/markdown` (and `@lezer/highlight`, pulled by markdown) is 1.0 MB. Versions pinned to SilverBullet's (`@lezer/lr` 1.4.10, `@lezer/common` 1.5.2, `@lezer/markdown` 1.7.2). Keeping the grammar in step with SilverBullet means re-copying three files per SilverBullet release that changes the grammar; `lua.grammar` is copied too so a diff shows what changed.

## 2. Markdown: SilverBullet's parser or our own?

**Answer.** Neither SilverBullet's Markdown parser nor its directive parser can be imported (not in the package; `client/markdown_parser/parser.ts` depends on `@codemirror/lang-markdown`, legacy modes, custom block parsers and the Lua language object). What the filter needs is small and comes from the parts SilverBullet itself builds on:

* `@lezer/markdown` (the base of SilverBullet's parser) finds fenced blocks with their info string (`FencedCode`/`CodeInfo`), indented code (`CodeBlock`) and code spans (`InlineCode`) by CommonMark rules. Used as is.
* `${...}` directives: SilverBullet's inline rule is 60 lines (`client/markdown_parser/parser.ts:93-157`): `${` not inside code, then brace balancing, unbalanced means plain text. Re-implemented in `filter.ts` in 15 lines, same rules.
* `query[[...]]` is Lua syntax (`Query` node in the grammar), so it is found by the Lua parser inside a directive; outside a directive it is plain text in SilverBullet too (case P3).

Where the spike is more conservative than SilverBullet, on purpose: a fence inside an HTML comment is inert in SilverBullet ([execution-model.md](execution-model.md), section 1) but rejected here (case F3, rule `fence-hidden`, a line match); directives inside frontmatter or HTML blocks are inert in SilverBullet but are checked here. The one place where both parsers must agree exactly is code spans next to directives, since a backtick inside a directive can open a code span: cases X1–X3 show the filter and SilverBullet pick the same directive, because both apply CommonMark code-span rules.

## 3. The AST walk

**Answer.** `checkPage(source, allowlist)` in `filter.ts` returns `{ok, violations[]}` with every reason found (rule, detail, line). Rules, each on the lezer tree of `_(<body>)`, which is exactly how SilverBullet parses a directive:

* `fence`: a `space-lua`, `space-config` or `space-style` fence (also `~~~`, also with trailing info text).
* `function-definition`: `FunctionDef`, `Function`, `LocalFunction`, `FuncBody` (the last one catches `order by … using function(a, b) … end`, which the grammar does not wrap in `FunctionDef`).
* `assignment`: `Assign`, `Local` (only reachable inside a function body in an expression, so in practice covered by the rule above).
* `denied-name`: any *reference* to `load`, `loadstring`, `dofile`, `require`, `_G`, `rawget`, `rawset`, `rawequal`, `rawlen`, `getmetatable`, `setmetatable`, `os`, `io`, `net`, `shell`, `space`, `config`, `js`, `debug`, `package`, `system`, `editor`, `datastore`, `clientStore`, `event`, `sync`. A member name (`a.space`), a table key, a parameter or a label is not a reference.
* `call-not-allowed`: a `FunctionCall` whose static dotted root (`template.each`, `index.tag`, `obj:method` as `obj.method`) matches no allowlist entry (`name` exact, or `name.*`). `query[[…]]` counts as the call `query`.
* `dynamic-call`: a call whose callee is not a static path: `a[x](…)`, `f()(…)`, `(expr)(…)`, `("s"):m()`.
* `parse-error`: the body does not parse; undecidable, so rejected.

The whole filter is 200 lines; the walk itself about 60. The spike's denied names are a fixed list; the server's filter derives the same effect from the allowlist (a reference to a global name not on the list is rejected, [security.md](../security.md), section 5) and keeps the never-allowed names as a guard against configuration mistakes.

## 4. Test matrix

Run: `node run.ts`. *minimal* = `query`, `template.*` (the list the security model started with); *extended* = minimal + `index.*`, `string.*`, `views.*`. Bold = differs from the expectation.

| id | case | expected | minimal | extended | reasons (extended list) |
|---|---|---|---|---|---|
| T1 | plain space.readPage | reject | reject | reject | call-not-allowed: space.readPage; denied-name: space |
| T2 | _G with concatenated name | reject | reject | reject | dynamic-call; denied-name: _G |
| T3 | load(...)() | reject | reject | reject | dynamic-call; call-not-allowed: load; denied-name: load |
| T4 | query with space.readPage in where | reject | reject | reject | call-not-allowed: space.readPage; denied-name: space |
| T5 | harmless template.each over a query | accept | **reject** | accept | (minimal: call-not-allowed: index.tag) |
| T6 | page with a space-lua fence | reject | reject | reject | fence |
| T7 | page with a lua fence | accept | accept | accept | |
| T8a | `${` inside a code span | accept | accept | accept | |
| T8b | `${` inside a fenced code block | accept | accept | accept | |
| T8c | `${` inside an indented code block | accept | accept | accept | |
| O1 | space via string index `space["readPage"]` | reject | reject | reject | dynamic-call; denied-name: space |
| O2 | js.window.fetch | reject | reject | reject | call-not-allowed: js.window.fetch; denied-name: js |
| O3 | config.get | reject | reject | reject | call-not-allowed: config.get; denied-name: config |
| O4 | `space` passed as a value | reject | reject | reject | denied-name: space |
| O5 | method call on a literal `("x"):upper()` | reject | reject | reject | dynamic-call |
| O6 | call on a call result `f(...)()` | reject | reject | reject | dynamic-call |
| O7 | dofile | reject | reject | reject | call-not-allowed: dofile; denied-name: dofile |
| O8 | directive spanning lines | reject | reject | reject | call-not-allowed: space.readPage; denied-name: space |
| O9 | directive inside a heading | reject | reject | reject | same |
| O10 | directive inside a table cell | reject | reject | reject | same |
| D1 | anonymous function called at once | reject | reject | reject | dynamic-call; function-definition |
| D2 | function as template.each callback | reject | reject | reject | function-definition |
| D3 | order by … using function | reject | reject | reject | function-definition |
| D4 | assignment inside a where clause | reject | reject | reject | dynamic-call; function-definition |
| D5 | statement where an expression is expected `${x = 1}` | reject | reject | reject | parse-error |
| F1 | space-style fence | reject | reject | reject | fence |
| F2 | space-config fence | reject | reject | reject | fence |
| F3 | space-lua fence inside an HTML comment | reject | reject | reject | fence-hidden |
| F4 | space-lua fence with trailing info | reject | reject | reject | fence |
| F5 | tilde fence | reject | reject | reject | fence |
| P1 | arithmetic `${1 + 2}` | accept | accept | accept | |
| P2 | bare reference `${templates.pageItem}` | accept | accept | accept | |
| P3 | `query[[…]]` as plain text outside a directive | accept | accept | accept | |
| P4 | unbalanced `${` (plain text for SilverBullet) | accept | accept | accept | |
| P5 | page footer `views.page(_CTX.currentPage.name)` | accept | **reject** | accept | (minimal: call-not-allowed: views.page) |
| P6 | query with string.startsWith in where | accept | **reject** | accept | (minimal: call-not-allowed: index.tag, string.startsWith) |
| P7 | no directive, "space" and "config.set" as words | accept | accept | accept | |
| P8 | frontmatter with `${5}` in a string | accept | accept | accept | |
| X1 | backtick in a directive opens a code span ending before a second directive | reject | reject | reject | call-not-allowed; denied-name |
| X2 | directive between two code spans | reject | reject | reject | same |
| X3 | backtick in a directive string, no second backtick | reject | reject | reject | same |

41 cases; with the extended list every verdict matches the expectation. Nothing the parser could not decide: an unparsable body is a rejection by rule, and SilverBullet would show an error for it anyway.

What the minimal list shows: pages of a typical space need `index.*` (every query reads `index.tag`/`index.pages()`), `views.*` (a page footer such as `views.page(...)`) and `string.*` (filters in `where`). `_CTX` is a reference, not a call, so it passes without an entry. This is why the shipped allowlist is the extended one ([security.md](../security.md), section 6).

## 5. Cost

**Answer.** 6.9 ms per 50 KB page (median of 50 runs; min 6.6, max 9.1), of which 3.4 ms is the Markdown parse. The page: 1 837 lines, 306 `${` occurrences, 204 checked directives (the rest sit in code spans and blocks), tables, lists, a `lua` fence. Sequential estimate for 3 000 such pages: 21 s; real pages are smaller and carry few directives, so a scan of a few thousand pages is seconds, not minutes. Run: `node bench.ts` (Apple silicon, Node 26). No measurement of memory.

## Open points and surprises

* The `FuncBody` rule is what catches `using function … end` in `order by`; a rule on `FunctionDef` alone would have missed it.
* Method calls on query variables (`p.name:upper()`) are rejected as `call-not-allowed` (`p.name.upper`): the filter cannot know `p`'s type. The model asks for `string.upper(p.name)` and leaves `*.upper`-style method entries to the operator ([security.md](../security.md), section 6).
* `template.each(..., templates.pageItem)`: `templates.pageItem` is a value reference and passes in the spike; the model therefore governs references, not only calls, and ships `templates.*` on the allowlist.
* The filter is stricter than SilverBullet in three places (fences in HTML comments, directives in frontmatter and HTML blocks, unbalanced `${`): harmless for agents, but a page copied in from elsewhere may be refused for an inert fence.
* Not covered by this spike: `*.plug.js` and `.html` files ([execution-model.md](execution-model.md), section 3) are not Markdown; the filter needs a file-type rule in front of it.
* Keeping the grammar current: three vendored files per SilverBullet release; `lua.grammar` is copied so the diff is visible.
