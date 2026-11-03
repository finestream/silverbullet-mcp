import test from "node:test";
import assert from "node:assert/strict";
import { checkPage } from "./filter.ts";
import { cases } from "./cases.ts";
import { compileAllowlist, parseAllowlist, SHIPPED_ALLOWLIST, shippedAllowlist, validateAllowlist } from "./allowlist.ts";

test("filter: every case of the matrix gets the verdict the security model asks for, with the shipped allowlist", () => {
  const allow = shippedAllowlist();
  const wrong = cases
    .map((c) => ({ ...c, verdict: checkPage(c.page, allow).ok ? "accept" : "reject" }))
    .filter((c) => c.verdict !== c.expect)
    .map((c) => `${c.id} ${c.name}: expected ${c.expect}, got ${c.verdict}`);
  assert.deepEqual(wrong, []);
  assert.equal(cases.length, 63);
});

test("filter: a violation names the rule, the line and the range of the directive", () => {
  const page = "# Title\n\nText ${1 + 1}\n\nBad: ${space.readPage(\"CONFIG\")} tail\n";
  const v = checkPage(page, shippedAllowlist());
  assert.equal(v.ok, false);
  assert.equal(v.directives, 2);
  assert.equal(v.violations.length, 1);
  const [x] = v.violations;
  assert.equal(x.rule, "denied-name");
  assert.equal(x.detail, "space.readPage");
  assert.equal(x.line, 5);
  assert.equal(page.slice(x.from, x.to), '${space.readPage("CONFIG")}');
});

test("filter: a fence violation spans the fence", () => {
  const page = "Text\n\n```space-lua\nfunction f() end\n```\n\nMore\n";
  const [x] = checkPage(page, shippedAllowlist()).violations;
  assert.equal(x.rule, "fence");
  assert.equal(page.slice(x.from, x.to), "```space-lua\nfunction f() end\n```");
});

test("filter: the same reason is reported once per directive", () => {
  const v = checkPage("${space.readPage(space.readPage(\"a\"))}\n", shippedAllowlist());
  assert.deepEqual(v.violations.map((x) => `${x.rule}: ${x.detail}`), ["denied-name: space.readPage"]);
});

test("allowlist: the shipped list is valid and the file format parses comments and blank lines", () => {
  assert.deepEqual(validateAllowlist(SHIPPED_ALLOWLIST), []);
  const entries = parseAllowlist("# comment\n\nquery\ntemplate.each  # trailing\n  templates.*\n");
  assert.deepEqual(entries, ["query", "template.each", "templates.*"]);
});

test("allowlist: entries that name or cover a never-allowed name are invalid", () => {
  const problems = validateAllowlist(["space.readPage", "config.*", "template.*", "index.*", "*", "*.new", "tag.define", "load", "bad name", "string.*"]);
  const bad = problems.map((p) => p.split('"')[1]);
  assert.deepEqual([...new Set(bad)], ["space.readPage", "config.*", "template.*", "index.*", "*", "*.new", "tag.define", "load", "bad name"]);
});

test("allowlist: `name.*` admits the name and everything under it, `*.method` admits that method on any value", () => {
  const allow = compileAllowlist(["query", "templates.*", "*.upper"]);
  assert.ok(allow.allows(["query"]));
  assert.ok(allow.allows(["templates"]));
  assert.ok(allow.allows(["templates", "pageItem"]));
  assert.ok(!allow.allows(["query", "x"]));
  assert.ok(allow.allows(["p", "name", "upper"]));
  assert.ok(!allow.allows(["upper"]));
  assert.ok(checkPage('${query[[from p = index.tag "x" where p.name:upper() == "A"]]}', compileAllowlist(["query", "index.tag", "*.upper"])).ok);
});
