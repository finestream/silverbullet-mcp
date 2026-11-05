// Test matrix of the write filter (docs/facts/write-filter.md, section 4, plus the
// rules the security model added after the spike). `expect` is what the
// security model asks for; the unit test and the release checks run it.

import type { TransclusionCheck } from "./filter.ts";

export type Case = { id: string; name: string; expect: "accept" | "reject"; page: string };

/**
 * The reader of the matrix: every case is checked as the page `Notes/Matrix`, whose reader may
 * read everything but `CONFIG` and what lies under `Private/`.
 */
export const matrixReader: TransclusionCheck = {
  page: "Notes/Matrix",
  denied: (target) => (target === "CONFIG" || target.startsWith("Private/") ? `no r on ${target}` : null),
};

const fence = (lang: string, body: string) => "```" + lang + "\n" + body + "\n```\n";

export const cases: Case[] = [
  // The cases the security model named first
  { id: "T1", name: "plain space.readPage", expect: "reject", page: 'Secret: ${space.readPage("CONFIG")}\n' },
  { id: "T2", name: "_G with concatenated name", expect: "reject", page: 'Secret: ${_G["sp".."ace"].readPage("CONFIG")}\n' },
  { id: "T3", name: "load(...)()", expect: "reject", page: '${load("return space.readPage(\\"CONFIG\\")")()}\n' },
  { id: "T4", name: "query with space.readPage in where", expect: "reject", page: '${query[[from index.tag "page" where space.readPage(name)]]}\n' },
  { id: "T5", name: "harmless template.each over a query", expect: "accept", page: '${template.each(query[[from p = index.tag "page" limit 3]], templates.pageItem)}\n' },
  { id: "T6", name: "page with a space-lua fence", expect: "reject", page: "Text.\n\n" + fence("space-lua", 'function f() return space.readPage("CONFIG") end') },
  { id: "T7", name: "page with a lua fence", expect: "accept", page: "Example:\n\n" + fence("lua", 'function f() return space.readPage("CONFIG") end') },
  { id: "T8a", name: "${ inside a code span", expect: "accept", page: 'Write `${space.readPage("CONFIG")}` to read a page.\n' },
  { id: "T8b", name: "${ inside a code block", expect: "accept", page: "Example:\n\n" + fence("", '${space.readPage("CONFIG")}') },
  { id: "T8c", name: "${ inside an indented code block", expect: "accept", page: 'Example:\n\n    ${space.readPage("CONFIG")}\n' },

  // Obfuscation and variants
  { id: "O1", name: "space via string index", expect: "reject", page: '${space["readPage"]("CONFIG")}\n' },
  { id: "O2", name: "js bridge fetch", expect: "reject", page: '${js.window.fetch("/.fs/CONFIG.md")}\n' },
  { id: "O3", name: "config.get", expect: "reject", page: '${config.get("kanboard.token")}\n' },
  { id: "O4", name: "space passed as a value", expect: "reject", page: '${template.each({space}, templates.pageItem)}\n' },
  { id: "O5", name: "method call on a literal", expect: "reject", page: '${("CONFIG"):upper()}\n' },
  { id: "O6", name: "call on a call result", expect: "reject", page: '${template.each(query[[from index.tag "page"]], templates.pageItem)()}\n' },
  { id: "O7", name: "dofile", expect: "reject", page: '${dofile("code.lua")}\n' },
  { id: "O8", name: "directive spanning lines", expect: "reject", page: 'Here: ${\n  space.readPage(\n    "CONFIG")\n}\n' },
  { id: "O9", name: "directive inside a heading", expect: "reject", page: '# Title ${space.readPage("CONFIG")}\n' },
  { id: "O10", name: "directive inside a table cell", expect: "reject", page: '| a | b |\n|---|---|\n| x | ${space.readPage("CONFIG")} |\n' },

  // Definitions and assignments
  { id: "D1", name: "anonymous function called at once", expect: "reject", page: "${(function() return 1 end)()}\n" },
  { id: "D2", name: "function as template.each callback", expect: "reject", page: '${template.each(query[[from index.tag "page"]], function(p) return p.name end)}\n' },
  { id: "D3", name: "order by ... using function", expect: "reject", page: '${query[[from p = index.tag "page" order by p.name using function(a, b) return a < b end]]}\n' },
  { id: "D4", name: "assignment in a where clause", expect: "reject", page: '${query[[from p = index.tag "page" where (function() _G.x = 1 return true end)()]]}\n' },
  { id: "D5", name: "statement where an expression is expected", expect: "reject", page: "${x = 1}\n" },

  // Other fences and hidden fences
  { id: "F1", name: "space-style fence", expect: "reject", page: fence("space-style", "body { display: none }") },
  { id: "F2", name: "space-config fence", expect: "reject", page: fence("space-config", "a: 1") },
  { id: "F3", name: "space-lua fence inside an HTML comment", expect: "reject", page: "<!--\n" + fence("space-lua", "function f() end") + "-->\n" },
  { id: "F4", name: "space-lua fence with trailing info", expect: "reject", page: fence("space-lua  -- priority: 10", "function f() end") },
  { id: "F5", name: "tilde fence", expect: "reject", page: "~~~space-lua\nfunction f() end\n~~~\n" },

  // Must pass
  { id: "P1", name: "arithmetic", expect: "accept", page: "Sum: ${1 + 2}\n" },
  { id: "P2", name: "bare reference", expect: "accept", page: "${templates.pageItem}\n" },
  { id: "P3", name: "query text outside a directive", expect: "accept", page: 'The query `query[[from index.tag "page"]]` and the text query[[from index.tag "page" where space.readPage(name)]] are plain text.\n' },
  { id: "P4", name: "unbalanced braces (plain text for SilverBullet)", expect: "accept", page: 'Cost: ${ not closed\n' },
  { id: "P5", name: "DR footer views.page(_CTX...)", expect: "accept", page: "${views.page(_CTX.currentPage.name)}\n" },
  { id: "P6", name: "query with string.* in where", expect: "accept", page: '${query[[from p = index.tag "page" where string.startsWith(p.name, "Agent/") select p.name]]}\n' },
  { id: "P7", name: "no directive at all, 'space' as a word", expect: "accept", page: "The space is the source of truth. config.set is documented on CONFIG.\n" },
  { id: "P8", name: "frontmatter with a dollar-brace in a string", expect: "accept", page: '---\ntitle: "costs ${5}"\n---\nText.\n' },

  // Code spans and directives interleaved: both parsers follow CommonMark code-span rules,
  // so the directive that SilverBullet would run is the one the filter sees.
  { id: "X1", name: "backtick inside a directive opens a code span that ends before a second directive", expect: "reject", page: '${"`"} text `${space.readPage("CONFIG")}` tail\n' },
  { id: "X2", name: "directive between two code spans", expect: "reject", page: '`a` ${space.readPage("CONFIG")} `b`\n' },
  { id: "X3", name: "backtick in a directive string, no second backtick", expect: "reject", page: '${space.readPage("`")}\n' },

  // References are governed by the allowlist, not only calls (security.md, section 5)
  { id: "R1", name: "bare global reference outside a query", expect: "reject", page: "${foo}\n" },
  { id: "R2", name: "value reference in a table key", expect: "reject", page: "${template.each({x = space}, templates.pageItem)}\n" },
  { id: "R3", name: "reference rooted in a parenthesis", expect: "reject", page: "${template.each({1}, (template).new)}\n" },
  { id: "R4", name: "function reference passed as a value from a select clause", expect: "reject", page: '${query[[from index.tag "page" select template.each({"CONFIG"}, space.readPage)]]}\n' },
  { id: "R5", name: "a namespace bound as a query source, then a method on it", expect: "reject", page: '${query[[from x = {template} select x.new("x")]]}\n' },

  // Functions that evaluate their input or write (never allowed, security.md section 6)
  { id: "E1", name: "template.new with a directive in its string", expect: "reject", page: "${template.each({1}, template.new(\"${space.readPage('CONFIG')}\"))}\n" },
  { id: "E2", name: "index.indexObjects", expect: "reject", page: '${index.indexObjects("x", {})}\n' },
  { id: "E3", name: "index.defineTag", expect: "reject", page: '${index.defineTag({name = "x"})}\n' },

  // Query clauses: fields, bound variables, aggregates (security.md, section 5)
  { id: "Q1", name: "a query without a named row (fields would shadow globals)", expect: "reject", page: '${query[[from index.tag "page" where status == "active" select name]]}\n' },
  { id: "Q2", name: "the implicit variable _ of an unnamed query", expect: "reject", page: '${query[[from index.tag "page" select _.tags[1]]]}\n' },
  { id: "Q2b", name: "the same query with a named row", expect: "accept", page: '${query[[from p = index.tag "page" where p.status == "active" select p.name]]}\n' },
  { id: "Q3", name: "group by with key, group and count()", expect: "accept", page: '${query[[from p = index.objects("tag") group by p.name select {key = key, n = #group, c = count()}]]}\n' },
  { id: "Q4", name: "a nested query uses the outer variable", expect: "accept", page: '${query[[from p = index.tag "page" select query[[from q = index.tag "item" where q.page == p.name]]]]}\n' },
  { id: "Q5", name: "a method on a query variable", expect: "reject", page: '${query[[from p = index.tag "page" where p.name:startsWith("A")]]}\n' },
  { id: "Q6", name: "a bare global passed as a callback inside a clause", expect: "reject", page: '${query[[from p = index.tag "page" select template.each({"CONFIG"}, readAll)]]}\n' },
  { id: "Q7", name: "order by using a named comparator", expect: "reject", page: '${query[[from p = index.tag "page" order by p.name using mycmp]]}\n' },
  { id: "Q8", name: "an aggregate with a filter", expect: "accept", page: '${query[[from p = index.tag "page" group by p.status select {n = count() filter (where p.name == "x")}]]}\n' },

  // The tag argument of a query or an index.* call (security.md, section 5)
  { id: "G1", name: "tag argument is not a literal", expect: "reject", page: "${query[[from index.tag(x) select name]]}\n" },
  { id: "G2", name: "tag argument is space-lua", expect: "reject", page: '${query[[from s = index.tag "space-lua" select s.ref]]}\n' },
  { id: "G3", name: "index.objects with space-style", expect: "reject", page: '${index.objects("space-style")}\n' },
  { id: "G4", name: "index.getObjectByRef with a literal tag", expect: "accept", page: '${index.getObjectByRef("A", "page", "A")}\n' },
  { id: "G5", name: "index.getObjectByRef with a non-literal tag", expect: "reject", page: '${index.getObjectByRef("A", t, "A")}\n' },
  { id: "G6", name: "index.pages() without a tag", expect: "accept", page: "${query[[from p = index.pages() limit 3]]}\n" },
  { id: "G7", name: "index.queryLuaObjects takes a query as data (a Lua syntax tree as a table)", expect: "reject", page: '${index.queryLuaObjects("page", {where = {type = "Variable", name = "space"}})}\n' },

  // Never-allowed names and their reviewed members (security.md, section 6): with the shipped list a
  // reviewed member is refused like the rest; an exact allowlist entry admits it (filter.test.ts).
  { id: "N1", name: "os.date with the shipped list", expect: "reject", page: 'Today: ${os.date("%Y-%m-%d")}\n' },
  { id: "N2", name: "template.fromPage reads a page named by its argument and evaluates it", expect: "reject", page: '${template.fromPage("CONFIG")()}\n' },
  { id: "N3", name: "lua.evalExpression evaluates its input", expect: "reject", page: '${lua.evalExpression("space.readPage(\'CONFIG\')")}\n' },
  { id: "N4", name: "a registry of the standard library", expect: "reject", page: '${slashCommand.define({name = "x", run = templates.pageItem})}\n' },

  // Baked sections: the expression of `<!--#lua EXPR -->` is re-evaluated by a person's command
  { id: "B1", name: "a baked section with code", expect: "reject", page: '<!--#lua space.readPage("CONFIG") -->\n| a |\n<!--/lua-->\n' },
  { id: "B2", name: "a baked section with an allowed query", expect: "accept", page: '<!--#lua query[[from p = index.tag "page" select p.name]] -->\n| name |\n<!--/lua-->\n' },
  { id: "B3", name: "a baked marker inside a code block is still found by SilverBullet's baker", expect: "reject", page: "```\n<!--#lua space.readPage(\"CONFIG\") -->\n```\n" },
  { id: "B4", name: "a baked marker inside a code span", expect: "reject", page: "Text `<!--#lua config.get(\"x\") -->` more\n" },
  // Transclusions of what the reader may not read (matrixReader): SilverBullet 2.12.1 expands every one of these
  { id: "R1", name: "transclusion of an unreadable page", expect: "reject", page: "Intro\n\n![[CONFIG]]\n" },
  { id: "R2", name: "transclusion with a heading", expect: "reject", page: "![[Private/Plan#Budget]]\n" },
  { id: "R3", name: "transclusion with an alias", expect: "reject", page: "![[Private/Plan|the plan]]\n" },
  { id: "R4", name: "transclusion with a heading and an alias", expect: "reject", page: "![[Private/Plan#Budget|the budget]]\n" },
  { id: "R5", name: "transclusion with a position", expect: "reject", page: "![[Private/Plan@12]]\n" },
  { id: "R6", name: "transclusion with an anchor", expect: "reject", page: "![[Private/Plan$block]]\n" },
  { id: "R7", name: "transclusion with a leading slash", expect: "reject", page: "![[/CONFIG]]\n" },
  { id: "R8", name: "transclusion with the .md extension", expect: "reject", page: "![[CONFIG.md]]\n" },
  { id: "R9", name: "transclusion with the ^ prefix", expect: "reject", page: "![[^CONFIG]]\n" },
  { id: "R10", name: "transclusion inside an HTML comment (expanded all the same)", expect: "reject", page: "<!-- ![[CONFIG]] -->\n" },
  { id: "R11", name: "transclusion inside an HTML block", expect: "reject", page: "<div>![[CONFIG]]</div>\n" },
  { id: "R12", name: "transclusion inside the frontmatter", expect: "reject", page: '---\nnote: "![[CONFIG]]"\n---\nText.\n' },
  { id: "R13", name: "transclusion in a list item and a table cell", expect: "reject", page: "* ![[CONFIG]]\n\n| a |\n|---|\n| ![[Private/Plan]] |\n" },
  { id: "R14", name: "transclusion of an unreadable file", expect: "reject", page: "![[Private/photo.png|300]]\n" },
  { id: "R15", name: "image form with an absolute path", expect: "reject", page: "![plan](/Private/Plan)\n" },
  { id: "R16", name: "image form, relative to the page's folder", expect: "reject", page: "![plan](../Private/Plan.md#Budget)\n" },
  { id: "R17", name: "image form in angle brackets, percent-encoded", expect: "reject", page: "![plan](</Private%2FPlan>)\n" },
  { id: "R26", name: "image form in angle brackets with a space in the name", expect: "reject", page: "![plan](</Private/My plan>)\n" },
  { id: "R18", name: "transclusion of a readable page", expect: "accept", page: "![[Projects/One]]\n\n![[Projects/One#Goals|the goals]]\n\n![one](/Projects/One)\n" },
  { id: "R19", name: "transclusion inside a code span", expect: "accept", page: "Write `![[CONFIG]]` to transclude a page.\n" },
  { id: "R20", name: "transclusion inside a fenced block", expect: "accept", page: "Example:\n\n" + fence("", "![[CONFIG]]") },
  { id: "R21", name: "transclusion inside an indented code block", expect: "accept", page: "Example:\n\n    ![[CONFIG]]\n" },
  { id: "R22", name: "a link is not a transclusion", expect: "accept", page: "See [[CONFIG]] and [the plan](/Private/Plan).\n" },
  { id: "R23", name: "image from another site", expect: "accept", page: "![logo](https://example.org/Private/logo.png)\n" },
  { id: "R24", name: "a heading of the page itself", expect: "accept", page: "# Intro\n\nText.\n\n![[#Intro]]\n" },
  { id: "R25", name: "escaped opening bracket (plain text for SilverBullet)", expect: "accept", page: "!\\[[CONFIG]]\n" },
];
