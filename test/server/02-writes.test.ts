// Writes through the server: the write filter (docs/security.md, section 5),
// the file-type rule, Library/ unfiltered only with w, conditional edits with
// dryRun (docs/architecture.md, "Tool surface").

import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, connect, BEARERS, DEFAULT_ACCESS_LIST, unique, type RunningServer, type McpClient } from "./harness.ts";
import { sb, T } from "../lib/env.ts";

let server: RunningServer;
let alice: McpClient;
let bob: McpClient;
/** Files the tests create in alpha; removed as admin at the end (alice has no d under Projects/). */
const created: string[] = [];
const track = (name: string) => {
  created.push(name.includes(".") ? name : `${name}.md`);
  return name;
};

before(async () => {
  server = await startServer({ accessList: DEFAULT_ACCESS_LIST + "bob beta / rw\nbob beta Library/ rw\n", env: { MCP_FILE_TYPES: ".md,.csv" } });
  alice = await connect(server.url, BEARERS.alice);
  bob = await connect(server.url, BEARERS.bob);
});

after(async () => {
  await Promise.all([alice?.close(), bob?.close()]);
  await server?.stop();
  for (const f of created) await sb.remove(T.admin, "alpha", f);
});

const REFUSED: Array<[string, string, RegExp]> = [
  ["a space-lua fence", "Text\n\n```space-lua\nfunction f() end\n```\n", /line 3, fence: ```space-lua block/],
  ["a space-style fence with tildes", "~~~space-style\nbody {}\n~~~\n", /line 1, fence: ```space-style/],
  ["a fence inside an HTML comment", "<!--\n```space-lua\nx = 1\n```\n-->\n", /line 2, fence-hidden/],
  ["a function definition in a directive", "List: ${template.each(query[[from p = index.tag \"page\"]], function(p) return p.name end)}\n", /line 1, function-definition/],
  ["an assignment in a where clause", '${query[[from p = index.tag "page" where (function() _G.x = 1 return true end)()]]}\n', /function-definition/],
  ["a call not on the allowlist", 'A\n\nB ${space.readPage("CONFIG")}\n', /line 3, denied-name: space.readPage/],
  ["a reference not on the allowlist", "${foo.bar}\n", /line 1, reference-not-allowed: foo.bar/],
  ["a dynamic call", '${_G["sp".."ace"].readPage("CONFIG")}\n', /dynamic-call/],
  ["a tag that is not a literal", "${query[[from index.tag(x) select name]]}\n", /tag-not-literal/],
  ["the space-lua tag", '${query[[from s = index.tag "space-lua" select s.ref]]}\n', /script-tag: index.tag "space-lua"/],
  ["a directive that does not parse", "${x = 1}\n", /parse-error/],
  ["a baked section with code (re-evaluated by a person's command)", '<!--#lua space.readPage("CONFIG") -->\n| a |\n<!--/lua-->\n', /line 1, denied-name: space.readPage/],
  ["a query without a named row", '${query[[from index.tag "page" where status == "x" select name]]}\n', /unnamed-query/],
];

test("write filter: each rule refuses the write, naming the rule and the line; nothing is written", async () => {
  for (const [what, content, expected] of REFUSED) {
    const name = unique("Projects/Filtered");
    const r = await alice.call("create-note", { filename: name, content });
    assert.equal(r.isError, true, `${what}: accepted?\n${r.text}`);
    assert.match(r.text, /^Refused by the write filter: the page would hold code \(/, what);
    assert.match(r.text, expected, what);
    assert.equal((await sb.read(T.alice, "alpha", `${name}.md`)).status, 404, `${what}: nothing was written`);
  }
});

test("write filter: a clean page with queries, templates and the DR footer is accepted", async () => {
  const name = track(unique("Projects/Clean"));
  const content = [
    "---",
    "tags: project",
    "status: active",
    "---",
    "# Clean",
    "",
    "Sum: ${1 + 2}",
    "${template.each(query[[from p = index.tag \"page\" where string.startsWith(p.name, \"Projects/\") order by p.name limit 3]], templates.pageItem)}",
    "${query[[from q = index.tag \"page\" where q.status == \"active\" select q.name]]}",
    "",
    "A `${space.readPage(\"CONFIG\")}` in a code span is text.",
    "",
    "${views.page(_CTX.currentPage.name)}",
    "",
  ].join("\n");
  const r = await alice.call("create-note", { filename: name, content });
  assert.equal(r.isError, false, r.text);
  assert.match(r.data!.revision, /^"sha256:/);
  const back = await alice.call("read-note", { filename: name });
  assert.equal(back.data!.content, content);
});

test("write filter: edit-note filters the resulting page, not the edit", async () => {
  const name = track(unique("Projects/Edited"));
  const created = await alice.call("create-note", { filename: name, content: "Value: ${1 + 1}\n" });
  assert.equal(created.isError, false, created.text);
  const bad = await alice.call("edit-note", { filename: name, expectedRevision: created.data!.revision, edits: [{ oldText: "1 + 1", newText: 'space.readPage("CONFIG")' }] });
  assert.equal(bad.isError, true);
  assert.match(bad.text, /Refused by the write filter.*denied-name: space.readPage/);
  const same = await alice.call("read-note", { filename: name });
  assert.equal(same.data!.content, "Value: ${1 + 1}\n", "nothing was written");
});

test("write filter: Library/ is not filtered, and is writable only with w (bob on beta, not alice on alpha)", async () => {
  const code = "```space-lua\nfunction test_lib_fn() return 1 end\n```\n";
  const denied = await alice.call("create-note", { filename: "Library/Agent", content: code });
  assert.equal(denied.isError, true);
  assert.match(denied.text, /Denied by the access list: user "alice" has no "w" on alpha\/Library\/Agent/);
  const name = unique("Library/Bot");
  const ok = await bob.call("create-note", { filename: name, content: code });
  assert.equal(ok.isError, false, ok.text);
  await bob.call("delete-note", { filename: name }); // bob has no d: cleaned up below as admin
  await sb.remove(T.admin, "beta", `${name}.md`);
  const relaxed = server.logs.filter((l) => l.includes("config.relaxed") && l.includes("Library/"));
  assert.ok(relaxed.length > 0, "w on Library/ is reported at start as a relaxed setting");
});

test("the report page cannot be written or deleted through the tools", async () => {
  const r = await alice.call("create-note", { filename: "MCP Server", content: "fake report", overwrite: true });
  assert.equal(r.isError, true);
  assert.match(r.text, /is the server's report page/);
  const d = await alice.call("delete-note", { filename: "MCP Server" });
  assert.match(d.text, /is the server's report page/);
});

test("file types: .md and the configured .csv are written; .png is refused; .html and .plug.js are never written", async () => {
  const csv = await alice.call("create-note", { filename: track(unique("Projects/data") + ".csv"), content: "a,b\n1,2\n" });
  assert.equal(csv.isError, false, csv.text);
  const png = await alice.call("create-note", { filename: "Projects/pic.png", content: "iVBORw0KGgo=", encoding: "base64" });
  assert.equal(png.isError, true);
  assert.match(png.text, /^Refused by the file-type rule: "Projects\/pic.png" is not of an allowed type \(allowed: .md, .csv\)/);
  for (const f of ["Projects/page.html", "Projects/x.plug.js", "Projects/x.lua"]) {
    const r = await alice.call("create-note", { filename: f, content: "x" });
    assert.equal(r.isError, true);
    assert.match(r.text, /^Refused by the file-type rule: ".*" files are executed or served as code/, f);
  }
  assert.ok(server.logs.some((l) => l.includes("config.relaxed") && l.includes(".csv")), "an extra file type is reported as a relaxed setting");
});

test("edit-note: a stale revision is rejected; dryRun returns the diff and writes nothing; a fresh revision writes", async () => {
  const name = track(unique("Projects/Conditional"));
  const created = await alice.call("create-note", { filename: name, content: "alpha beta gamma\n" });
  assert.equal(created.isError, false, created.text);
  const rev = created.data!.revision as string;

  const stale = await alice.call("edit-note", { filename: name, expectedRevision: '"sha256:0000"', edits: [{ oldText: "beta", newText: "BETA" }] });
  assert.equal(stale.isError, true);
  assert.match(stale.text, /^Revision conflict: .* Read it again before editing. Nothing was written./);

  const dry = await alice.call("edit-note", { filename: name, expectedRevision: rev, dryRun: true, edits: [{ oldText: "beta", newText: "BETA" }] });
  assert.equal(dry.isError, false, dry.text);
  assert.equal(dry.data!.applied, false);
  assert.equal(dry.data!.changed, true);
  assert.match(dry.data!.diff, /-alpha beta gamma\n\+alpha BETA gamma/);
  assert.equal((await sb.read(T.alice, "alpha", `${name}.md`)).text, "alpha beta gamma\n", "dryRun wrote nothing");

  const applied = await alice.call("edit-note", { filename: name, expectedRevision: rev, edits: [{ oldText: "beta", newText: "BETA" }, { oldText: "m", newText: "M", expectedMatches: 2 }] });
  assert.equal(applied.isError, false, applied.text);
  assert.equal(applied.data!.applied, true);
  assert.deepEqual(applied.data!.replacements, [1, 2]);
  assert.notEqual(applied.data!.revision, rev);
  assert.equal((await sb.read(T.alice, "alpha", `${name}.md`)).text, "alpha BETA gaMMa\n");

  // The old revision is stale now; SilverBullet's 412 becomes a conflict too.
  const again = await alice.call("edit-note", { filename: name, expectedRevision: rev, edits: [{ oldText: "BETA", newText: "x" }] });
  assert.equal(again.isError, true);
  assert.match(again.text, /Revision conflict/);

  const missing = await alice.call("edit-note", { filename: name, edits: [{ oldText: "BETA", newText: "x" }] } as Record<string, unknown>);
  assert.equal(missing.isError, true, "expectedRevision is required");
});

test("search: a pattern that backtracks catastrophically is refused after the time limit instead of blocking the server", async () => {
  const name = track(unique("Projects/Backtrack"));
  const created = await alice.call("create-note", { filename: name, content: "a".repeat(40) + "b\n" });
  assert.equal(created.isError, false, created.text);
  const t0 = performance.now();
  const r = await alice.call("search-notes", { query: "(a+)+$", maxResults: 5 });
  assert.equal(r.isError, true);
  assert.match(r.text, /took more than \d+ ms to match/);
  assert.ok(performance.now() - t0 < 6000, "the time limit holds");
  const names = await alice.call("list-notes", { namePattern: "^(P+|Pr)+x$" });
  assert.equal(names.isError, false, "a pattern that is harmless on short names still works");
  const literal = await alice.call("search-notes", { query: "(a+)+$", useRegex: false });
  assert.equal(literal.isError, false, literal.text);
});

test("create-note: an existing page is not overwritten without overwrite; read-multiple-notes reads by name and pattern", async () => {
  const name = track(unique("Projects/Once"));
  assert.equal((await alice.call("create-note", { filename: name, content: "first" })).isError, false);
  const twice = await alice.call("create-note", { filename: name, content: "second" });
  assert.equal(twice.isError, true);
  assert.match(twice.text, /already exists/);
  const multi = await alice.call("read-multiple-notes", { filenames: [name, "Projects/One", "CONFIG"], namePattern: "^Projects/Two" });
  assert.equal(multi.isError, false, multi.text);
  const notes = multi.data!.notes as Array<{ filename: string; content?: string; error?: string }>;
  assert.equal(notes.find((n) => n.filename === `${name}.md`)?.content, "first");
  assert.match(notes.find((n) => n.filename === "CONFIG.md")?.error ?? "", /Denied by the access list/);
  assert.ok(notes.some((n) => n.filename === "Projects/Two.md"));
});
