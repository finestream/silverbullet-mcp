// The never-allowed names and their reviewed members (docs/security.md,
// section 6): the list is maintained with SilverBullet's releases. Two
// assertions, both against the running release's Lua environment: every
// reviewed member still exists and behaves as reviewed (reads the clock, builds
// a plain table, reports a fact about the client), and every global of the
// environment is classified, as never allowed, as a reviewed harmless global,
// or as a name the fixtures define. A new global fails the second check until
// it has been reviewed and put on one of the lists.

import test, { before } from "node:test";
import assert from "node:assert/strict";
import { sb, T, S } from "../lib/env.ts";
import { NEVER_ALLOWED, REVIEWED_MEMBERS } from "../../src/filter/allowlist.ts";

before(async () => {
  await sb.runtimeReady(T.alice, S.alpha);
});

/**
 * Globals of 2.12.1 that are neither never allowed nor shipped: plain Lua, pure helpers and
 * the standard library's data tables. Not on the shipped allowlist; an operator may add them
 * after audit. Reviewed with the never-allowed list (docs/security.md, section 6).
 */
const HARMLESS_GLOBALS = [
  "_VERSION", "assert", "error", "pcall", "xpcall", "print", "type", "tostring", "tonumber", "select", "next", "pairs", "ipairs", "each", "some",
  "string", "table", "math", "encoding", "crypto", "date", "yaml", "jsonschema", "language", "icon", "search",
  "templates", "tags", "widgets", "formatMarkdownTable", "nodeParentOfType",
  // `index`, `template`, `identity` and `journal` have never-allowed members and are covered by those.
];

/** Globals the test fixtures define (test/seed): Library/Mine and the outside pages. */
const FIXTURE_GLOBALS = ["mylib_fn", "outside_marker", "inert_marker", "comment_marker"];

const NEVER_ROOTS = NEVER_ALLOWED.filter((n) => !n.includes("."));
const DOTTED_ROOTS = [...new Set(NEVER_ALLOWED.filter((n) => n.includes(".")).map((n) => n.split(".")[0]))];

test("api: every reviewed member of a never-allowed namespace exists and behaves as reviewed", async () => {
  const members = REVIEWED_MEMBERS.map((m) => `[${JSON.stringify(m)}] = type(${m})`).join(", ");
  const r = await sb.lua(
    T.alice,
    S.alpha,
    `return {
  types = { ${members} },
  date = os.date("%Y-%m-%d"),
  dateUtc = os.date("!%H"),
  time = os.time(),
  fixedTime = os.time({year = 2020, month = 1, day = 1, hour = 12}),
  difftime = os.difftime(10, 4),
  clock = os.clock(),
  schema = { schema.string(), schema.number(), schema.boolean(), schema.array("string"), schema.nullable("string"), schema.nullableArray("string"), schema.func(), schema.schema(), schema.object(), schema.null() },
  parsed = markdown.renderParseTree(markdown.parseMarkdown("# Title\\n\\nText \${1 + 1}")),
  version = system.getVersion(),
  mode = system.getMode(),
  baseURI = system.getBaseURI(),
  urlPrefix = system.getURLPrefix(),
  currentPage = editor.getCurrentPage(),
  currentPath = editor.getCurrentPath(),
  isMobile = editor.isMobile(),
  isNarrow = editor.isNarrowScreen(),
  baseUrl = spacelua.baseUrl(),
}`,
  );
  assert.equal(r.status, 200, r.raw);
  const got = r.result as Record<string, any>;
  const missing = REVIEWED_MEMBERS.filter((m) => got.types[m] !== "function");
  assert.deepEqual(missing, [], "every reviewed member is a function in this release");
  assert.match(got.date, /^\d{4}-\d{2}-\d{2}$/, "os.date formats the clock");
  assert.match(got.dateUtc, /^\d{2}$/);
  assert.equal(typeof got.time, "number");
  assert.equal(typeof got.fixedTime, "number");
  assert.ok(Math.abs(got.fixedTime - Date.UTC(2020, 0, 1, 12) / 1000) <= 14 * 3600, "os.time of a date table is that date, in the runtime's time zone");
  assert.equal(got.difftime, 6);
  assert.equal(typeof got.clock, "number");
  assert.deepEqual(got.schema, [
    { type: "string" }, { type: "number" }, { type: "boolean" }, { type: "array", items: { type: "string" } },
    { anyOf: [{ type: "string" }, { type: "null" }] }, { anyOf: [{ type: "array", items: { type: "string" } }, { type: "null" }] },
    {}, { type: "object" }, { type: "object" }, { type: "null" },
  ], "schema.* return plain tables");
  assert.equal(got.parsed, "# Title\n\nText ${1 + 1}", "markdown.parseMarkdown and renderParseTree round-trip without evaluating the directive");
  assert.equal(typeof got.version, "string");
  assert.equal(typeof got.mode, "string");
  assert.equal(typeof got.baseURI, "string");
  assert.equal(typeof got.urlPrefix, "string");
  assert.ok(got.currentPage === null || got.currentPage === undefined || typeof got.currentPage === "string", "editor.getCurrentPage is a page name or nil in a headless runtime");
  assert.ok(got.currentPath === null || got.currentPath === undefined || typeof got.currentPath === "string");
  assert.equal(typeof got.isMobile, "boolean");
  assert.equal(typeof got.isNarrow, "boolean");
  assert.equal(typeof got.baseUrl, "string");
});

test("api: every global of the release's Lua environment is classified (never allowed, reviewed harmless, or a fixture)", async () => {
  const r = await sb.lua(T.alice, S.alpha, "local t = {} for k, v in pairs(_G) do table.insert(t, k) end table.sort(t) return t");
  assert.equal(r.status, 200, r.raw);
  const globals = r.result as string[];
  assert.ok(globals.includes("os") && globals.includes("space") && globals.includes("index"), `the environment is the full one: ${globals.join(", ")}`);
  const known = new Set([...NEVER_ROOTS, ...DOTTED_ROOTS, ...HARMLESS_GLOBALS, ...FIXTURE_GLOBALS]);
  const unknown = globals.filter((g) => !known.has(g));
  assert.deepEqual(unknown, [], "new globals in this release: review each and add it to NEVER_ALLOWED (src/filter/allowlist.ts) or to HARMLESS_GLOBALS here, and to docs/security.md section 6");
  // The never-allowed roots that exist in this release; the ones that do not are kept against a release that adds them.
  const absent = NEVER_ROOTS.filter((n) => !globals.includes(n));
  assert.deepEqual(absent.sort(), ["debug", "io", "loadstring", "package", "require"].sort(), "never-allowed names absent from this release");
});
