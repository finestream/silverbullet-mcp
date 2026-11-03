// Test matrix for the write filter spike. `expect` is what the security model
// asks for; the run records what the filter actually says.

export type Case = { id: string; name: string; expect: "accept" | "reject"; page: string };

const fence = (lang: string, body: string) => "```" + lang + "\n" + body + "\n```\n";

export const cases: Case[] = [
  // The cases the security model named first
  { id: "T1", name: "plain space.readPage", expect: "reject", page: 'Secret: ${space.readPage("CONFIG")}\n' },
  { id: "T2", name: "_G with concatenated name", expect: "reject", page: 'Secret: ${_G["sp".."ace"].readPage("CONFIG")}\n' },
  { id: "T3", name: "load(...)()", expect: "reject", page: '${load("return space.readPage(\\"CONFIG\\")")()}\n' },
  { id: "T4", name: "query with space.readPage in where", expect: "reject", page: '${query[[from index.tag "page" where space.readPage(name)]]}\n' },
  { id: "T5", name: "harmless template.each over a query", expect: "accept", page: '${template.each(query[[from index.tag "page" limit 3]], templates.pageItem)}\n' },
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
];
