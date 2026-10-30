// Spike: rendering a page through SilverBullet's Runtime API, as the token's user.
// Run against the test instance (node >= 23 runs TypeScript directly):
//
//   docker compose -f test/compose.yaml run --rm bootstrap
//   node spike/render.ts
//
// Each check prints PASS/FAIL with what it saw. Screenshots go to spike/out/.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const env = Object.fromEntries(
  readFileSync(new URL("../test/.state/env", import.meta.url), "utf8")
    .trim()
    .split("\n")
    .map((line) => line.split(/=(.*)/s).slice(0, 2)),
);
const SB = env.SB_URL;
const ALICE = env.SB_TOKEN_ALICE; // alpha: write + runtime; beta: none
const BOB = env.SB_TOKEN_BOB; // alpha: read; beta: write + runtime

// A Lua long-bracket string literal that cannot be closed by its content.
function luaString(s: string): string {
  let level = 0;
  while (s.includes("]" + "=".repeat(level) + "]")) level++;
  const eq = "=".repeat(level);
  return `[${eq}[\n${s}]${eq}]`; // a leading newline is dropped by Lua
}

// The render script: expand `${…}`, queries, templates and transclusions of one page.
// 2.12.1 sets no `_CTX` inside markdown.expandMarkdown, so the script provides one
// (the edge release adds a `pageName` option for this). Writes through `space.*`
// are shadowed for the duration of the call; see the bypass check below.
function renderScript(page: string): string {
  return `
local name = ${luaString(page)}
local blocked = function() error("rendering is read-only") end
local saved = {}
for _, f in ipairs({"writePage", "deletePage", "writeFile", "deleteFile", "writeDocument", "deleteDocument"}) do
  saved[f] = space[f]
  space[f] = blocked
end
_CTX = {currentPage = index.getObjectByRef(name, "page", name) or space.getPageMeta(name)}
local ok, result = pcall(function() return markdown.expandMarkdown(space.readPage(name)) end)
_CTX = nil
for f, fn in pairs(saved) do space[f] = fn end
if not ok then error(result) end
return result`;
}

async function runtime(token: string, space: string, script: string) {
  const t0 = performance.now();
  const r = await fetch(`${SB}/${space}/.runtime/lua_script`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "X-Timeout": "120" },
    body: script,
  });
  const text = await r.text();
  let body: any = text;
  try {
    body = JSON.parse(text);
  } catch {}
  return { status: r.status, body, ms: Math.round(performance.now() - t0) };
}

async function fileStatus(token: string, space: string, path: string) {
  const r = await fetch(`${SB}/${space}/.fs/${encodeURI(path)}`, { headers: { Authorization: `Bearer ${token}` } });
  return r.status;
}

let failures = 0;
function check(name: string, ok: boolean, seen: unknown) {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}  ${typeof seen === "string" ? seen : JSON.stringify(seen)}`);
}

// 1. Render with everything evaluated, on whatever runtime state there is (cold or warm).
const r1 = await runtime(ALICE, "alpha", renderScript("Rendered"));
const md: string = r1.body?.result ?? "";
check("render: status 200", r1.status === 200, `${r1.status} in ${r1.ms} ms`);
check("render: ${1 + 2} evaluated", md.includes("Sum: 3"), md.match(/Sum: .*/)?.[0]);
check("render: _CTX.currentPage set", md.includes("Current page: Rendered"), md.match(/Current page: .*/)?.[0]);
check("render: query evaluated", md.includes("Projects/One") && md.includes("parked"), "query rows present");
check("render: template evaluated", md.includes("* [[Projects/One]] is active"), md.match(/\* \[\[Projects\/One\]\].*/)?.[0]);
check("render: transclusion expanded", md.includes("marker-alpha-one"), "transcluded body present");
check("render: query results come as HTML tables", md.includes("<table>"), "a Markdown table would need a different renderer");

// 2. A render must not write: the page calls space.writePage.
const r2 = await runtime(ALICE, "alpha", renderScript("Side effect"));
check("guard: render of a writing page succeeds", r2.status === 200, r2.body?.result?.match(/\*\*Error:\*\*.*/)?.[0]);
check("guard: nothing was written", (await fileStatus(ALICE, "alpha", "Side effect output.md")) === 404, "Side effect output.md absent");

// 3. The guard is best-effort: JavaScript fetch from the runtime still writes as the user.
const r3 = await runtime(
  ALICE,
  "alpha",
  `local r = js.window.fetch("/alpha/.fs/Bypass.md", {method = "PUT", body = "x", headers = {["X-Sync-Mode"] = "true"}})
return r.status`,
);
const bypassed = (await fileStatus(ALICE, "alpha", "Bypass.md")) === 200;
check("guard: fetch() bypass is possible (expected: yes)", bypassed, `PUT from runtime -> ${r3.body?.result}`);
await fetch(`${SB}/alpha/.fs/Bypass.md`, { method: "DELETE", headers: { Authorization: `Bearer ${ALICE}` } });

// 4. The runtime is the token's user: alice's alpha runtime cannot read beta.
const r4 = await runtime(
  ALICE,
  "alpha",
  `local r = js.window.fetch("/beta/.fs/Secret.md", {headers = {["X-Sync-Mode"] = "true"}})
return r.status`,
);
check("isolation: alice's runtime cannot read beta", r4.body?.result === 401, `fetch /beta from alice/alpha -> ${r4.body?.result}`);
const r5 = await runtime(ALICE, "beta", "return 1");
check("isolation: alice gets no runtime on beta", r5.status === 403, `${r5.status} ${JSON.stringify(r5.body)}`);
const r6 = await runtime(BOB, "alpha", "return 1");
check("isolation: a read-only member gets no runtime", r6.status === 403, `${r6.status} ${JSON.stringify(r6.body)}`);
const r7 = await runtime(BOB, "beta", 'return space.readPage("Secret")');
check("isolation: bob's runtime reads beta", String(r7.body?.result).includes("marker-beta-secret"), `${r7.status} in ${r7.ms} ms`);

// 5. Screenshot of a given page: navigate, then capture; optionally clipped to a selector.
mkdirSync(new URL("out/", import.meta.url), { recursive: true });
await runtime(ALICE, "alpha", `editor.navigate(${luaString("Rendered")})`);
for (const [name, query] of [
  ["viewport", ""],
  ["editor", "?selector=%23sb-editor"],
  ["fullpage", "?fullPage=1"],
] as const) {
  const t0 = performance.now();
  const r = await fetch(`${SB}/alpha/.runtime/screenshot${query}`, { headers: { Authorization: `Bearer ${ALICE}` } });
  const png = Buffer.from(await r.arrayBuffer());
  writeFileSync(new URL(`out/${name}.png`, import.meta.url), png);
  const size = r.status === 200 ? `${png.readUInt32BE(16)}x${png.readUInt32BE(20)}` : "-";
  check(`screenshot ${name}`, r.status === 200, `${r.status} ${size} ${png.length} B in ${Math.round(performance.now() - t0)} ms`);
}

process.exit(failures ? 1 : 0);
