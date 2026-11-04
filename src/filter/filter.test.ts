import test from "node:test";
import assert from "node:assert/strict";
import { checkPage } from "./filter.ts";
import { cases } from "./cases.ts";
import { readFileSync } from "node:fs";
import { compileAllowlist, isNeverAllowed, NEVER_ALLOWED, parseAllowlist, REVIEWED_MEMBERS, SHIPPED_ALLOWLIST, shippedAllowlist, validateAllowlist } from "./allowlist.ts";

test("filter: every case of the matrix gets the verdict the security model asks for, with the shipped allowlist", () => {
  const allow = shippedAllowlist();
  const wrong = cases
    .map((c) => ({ ...c, verdict: checkPage(c.page, allow).ok ? "accept" : "reject" }))
    .filter((c) => c.verdict !== c.expect)
    .map((c) => `${c.id} ${c.name}: expected ${c.expect}, got ${c.verdict}`);
  assert.deepEqual(wrong, []);
  assert.equal(cases.length, 73);
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

test("filter: a page full of unclosed ${ is refused within a bounded time", () => {
  const t0 = performance.now();
  const v = checkPage("${".repeat(200_000), shippedAllowlist());
  assert.equal(v.ok, false);
  assert.equal(v.violations[0].rule, "too-complex");
  assert.ok(performance.now() - t0 < 2000, `${Math.round(performance.now() - t0)} ms`);
  // A realistic page with a few unclosed ${ is fine.
  assert.ok(checkPage("Cost: ${ not closed\n".repeat(200) + "Sum ${1 + 1}\n", shippedAllowlist()).ok);
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

test("allowlist: the shipped file config/allowlist is the shipped list and is valid (the image carries it; an invalid file refuses to serve)", () => {
  const entries = parseAllowlist(readFileSync(new URL("../../config/allowlist", import.meta.url), "utf8"));
  assert.deepEqual(entries, [...SHIPPED_ALLOWLIST]);
  assert.deepEqual(validateAllowlist(entries), []);
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

test("allowlist: an exact entry naming a reviewed member of a never-allowed namespace is valid; a wildcard under it or an unknown member is not", () => {
  assert.deepEqual(validateAllowlist(["os.date", "os.time", "schema.string", "markdown.parseMarkdown", "system.getVersion"]), []);
  const problems = validateAllowlist(["os.*", "*.date", "os.getenv", "os.exit", "os", "markdown.expandMarkdown", "template.fromPage", "template.*", "lua.evalExpression", "identity.define", "identity.mentions"]);
  assert.deepEqual(problems, [
    '"os.*" covers the never-allowed name "os"',
    '"os.getenv" is under the never-allowed name "os" and is not a reviewed member (docs/security.md, section 6)',
    '"os.exit" is under the never-allowed name "os" and is not a reviewed member (docs/security.md, section 6)',
    '"os" is a never-allowed name',
    '"markdown.expandMarkdown" is under the never-allowed name "markdown" and is not a reviewed member (docs/security.md, section 6)',
    '"template.fromPage" is a never-allowed name',
    '"template.*" covers the never-allowed name "template.new"',
    '"template.*" covers the never-allowed name "template.fromPage"',
    '"template.*" covers the never-allowed name "template.createPageFromTemplate"',
    '"lua.evalExpression" is under the never-allowed name "lua" and is not a reviewed member (docs/security.md, section 6)',
    '"identity.define" is a never-allowed name',
  ]);
  // `*.date` is a valid entry (no never-allowed name ends in `.date`), but it admits nothing under `os`: see below.
});

test("filter: a reviewed member passes only with its exact entry; the refusal names the rule and says an exact entry would admit it", () => {
  const page = 'Today: ${os.date("%Y-%m-%d")}, ${os.time()}\n';
  const shipped = checkPage(page, shippedAllowlist());
  assert.equal(shipped.ok, false);
  assert.deepEqual(shipped.violations.map((v) => `${v.rule}: ${v.detail}`), [
    "denied-name: os.date (allowable by an exact allowlist entry; not on this allowlist)",
    "denied-name: os.time (allowable by an exact allowlist entry; not on this allowlist)",
  ]);
  assert.ok(checkPage(page, compileAllowlist([...SHIPPED_ALLOWLIST, "os.date", "os.time"])).ok);
  // The entry admits that member and nothing else under the namespace.
  const only = compileAllowlist([...SHIPPED_ALLOWLIST, "os.date"]);
  assert.ok(checkPage('${os.date("%Y")}\n', only).ok);
  assert.deepEqual(checkPage("${os.time()}\n", only).violations.map((v) => v.rule), ["denied-name"]);
  assert.deepEqual(checkPage("${os.clock}\n", only).violations.map((v) => v.rule), ["denied-name"]);
  assert.deepEqual(checkPage("${os}\n", only).violations.map((v) => v.rule), ["denied-name"]);
  assert.deepEqual(checkPage('${os.date.x("%Y")}\n', only).violations.map((v) => v.rule), ["denied-name"]);
  // Wildcards never reach under a never-allowed name, even when valid as entries.
  assert.equal(checkPage('${os.date("%Y")}\n', compileAllowlist([...SHIPPED_ALLOWLIST, "*.date"])).ok, false);
  // An unreviewed member is refused without the hint.
  assert.deepEqual(checkPage('${markdown.expandMarkdown("x")}\n', only).violations.map((v) => v.detail), ["markdown.expandMarkdown"]);
  // A reviewed member in a query clause, bound names untouched.
  assert.ok(checkPage('${query[[from p = index.tag "page" where p.date == os.date("%Y-%m-%d") select p.name]]}\n', only).ok);
});

test("allowlist: the reviewed members all lie under a never-allowed name, none is itself never allowed, and no shipped entry is one", () => {
  for (const m of REVIEWED_MEMBERS) {
    assert.ok(m.includes("."), `${m} is not a member`);
    assert.ok(isNeverAllowed(m), `${m} is not under a never-allowed name`);
    assert.ok(!NEVER_ALLOWED.includes(m), `${m} is never allowed itself`);
  }
  assert.deepEqual(SHIPPED_ALLOWLIST.filter((e) => REVIEWED_MEMBERS.includes(e)), [], "the shipped list adds no reviewed member by itself");
  assert.deepEqual(validateAllowlist(REVIEWED_MEMBERS), []);
});
