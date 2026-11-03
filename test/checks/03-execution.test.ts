// The execution model (docs/facts/execution-model.md): which fences execute,
// where expressions are evaluated, what runs outside pages, how external
// writes arrive. Runs as alice on alpha, on a fresh runtime.

import test, { before } from "node:test";
import assert from "node:assert/strict";
import { sb, T, S, until } from "../lib/env.ts";
import { renderScript } from "../lib/lua.ts";

before(async () => {
  await sb.admin.resetRuntimes(T.admin);
  await sb.lua(T.alice, S.alpha, "return 1");
});

test("execution: only space-lua and space-style fences are indexed as objects; space-config is inert (section 1)", async () => {
  const r = await sb.lua(
    T.alice,
    S.alpha,
    `return {
  lua = #query[[from s = index.tag "space-lua" where string.startsWith(s.ref, "Outside@")]],
  style = #query[[from s = index.tag "space-style" where string.startsWith(s.ref, "Styled@")]],
  config = #query[[from s = index.tag "space-config"]],
  fromConfigFence = config.get("agentTest.fromConfigFence"),
}`,
  );
  const got = r.result as Record<string, unknown>;
  assert.deepEqual({ lua: got.lua, style: got.style, config: got.config, fromConfigFence: got.fromConfigFence ?? null }, { lua: 1, style: 1, config: 0, fromConfigFence: null }, r.raw);
});

test("execution: a lua fence and a space-lua fence inside an HTML comment are inert (sections 1, 5)", async () => {
  const r = await sb.lua(
    T.alice,
    S.alpha,
    `return {inert = inert_marker and "defined" or "nil", comment = comment_marker and "defined" or "nil",
  objects = #query[[from s = index.tag "space-lua" where string.startsWith(s.ref, "Inert@")]]}`,
  );
  assert.deepEqual(r.result, { inert: "nil", comment: "nil", objects: 0 }, r.raw);
});

test("execution: ${...} inside a code span is text; outside it is evaluated (section 5)", async () => {
  const r = await sb.lua(T.alice, S.alpha, renderScript("Inert"));
  const md = String(r.result);
  assert.ok(md.includes("`${1 + 1}`"), `the backticked expression stays literal: ${md.slice(0, 120)}`);
  assert.ok(md.includes("plain: 4"), `the plain expression is evaluated: ${md.slice(0, 120)}`);
});

test("execution: every query clause is full Lua: where reads a page, defines a function, assigns a global (section 2)", async () => {
  const d1 = await sb.lua(T.alice, S.alpha, `return #query[[from p = index.tag "page" where string.find(space.readPage("CONFIG"), "CONFIG%-SECRET") ~= nil limit 1]]`);
  assert.equal(d1.result, 1, `where reads CONFIG: ${d1.raw}`);
  const d2 = await sb.lua(T.alice, S.alpha, `return #query[[from p = index.tag "page" where (function() return true end)() limit 1]]`);
  assert.equal(d2.result, 1, `a function defined in where runs: ${d2.raw}`);
  const d3 = await sb.lua(T.alice, S.alpha, `local _ = query[[from p = index.tag "page" where (function() _G.leaked_from_where = "set" return true end)() limit 1]] return _G.leaked_from_where`);
  assert.equal(d3.result, "set", `an assignment in where sticks: ${d3.raw}`);
});

test("execution: a .lua file runs only through dofile (section 3)", async () => {
  const before_ = await sb.lua(T.alice, S.alpha, `return from_lua_file and "defined" or "nil"`);
  assert.equal(before_.result, "nil", "not defined by itself");
  const after = await sb.lua(T.alice, S.alpha, `dofile("code.lua") return from_lua_file()`);
  assert.equal(after.result, "lua-file-ran", after.raw);
});

test("execution: an .html file is served inline on the space's origin, without Content-Disposition and without a CSP (section 3)", async () => {
  const html = "<!doctype html><script>document.title='x'</script>";
  const put = await sb.write(T.alice, S.alpha, "served.html", html);
  assert.ok([200, 201, 204].includes(put.status), `PUT: ${put.status} ${put.text}`);
  const r = await sb.read(T.alice, S.alpha, "served.html");
  await sb.remove(T.alice, S.alpha, "served.html");
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type") ?? "", /text\/html/);
  assert.equal(r.headers.get("content-disposition"), null, "no Content-Disposition");
  assert.equal(r.headers.get("content-security-policy"), null, "no CSP");
});

test("execution: the server's event stream reports a write within 5 s (section 4)", async () => {
  const ac = new AbortController();
  const chunks: string[] = [];
  const stream = sb.events(T.alice, S.alpha, ac.signal).then(async (r) => {
    assert.equal(r.status, 200, "event stream opens");
    const reader = r.body!.getReader();
    const dec = new TextDecoder();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(dec.decode(value));
    }
  }).catch(() => {});
  await new Promise((r) => setTimeout(r, 500));
  const name = `Event ${Date.now()}.md`;
  await sb.write(T.alice, S.alpha, name, "an event");
  const seen = await until(async () => chunks.join("").includes(name.replace(/ /g, " ")) || chunks.join("").includes(encodeURIComponent(name)), 5000, 100);
  ac.abort();
  await stream;
  await sb.remove(T.alice, S.alpha, name);
  assert.ok(seen.value, `no event for ${name} in 5 s; got: ${chunks.join("").slice(0, 300)}`);
});

test("execution: a page written through the API is readable by the runtime at once (reads go through to the server)", async () => {
  const name = `External ${Date.now()}`;
  await sb.write(T.alice, S.alpha, `${name}.md`, "External page: EXT-PARA\n");
  const r = await sb.lua(T.alice, S.alpha, `return space.readPage(${JSON.stringify(name)})`);
  await sb.remove(T.alice, S.alpha, `${name}.md`);
  assert.ok(String(r.result).includes("EXT-PARA"), r.raw);
});

test("[watch] execution: the headless runtime indexes a page written through the API within 30 s (seen to lag; docs/facts/index-transform.md, open points)", async (t) => {
  const name = `External ${Date.now()}`;
  await sb.write(T.alice, S.alpha, `${name}.md`, "External page.\n");
  const seen = await until(async () => {
    const r = await sb.lua(T.alice, S.alpha, `return #query[[from p = index.tag "page" where p.name == ${JSON.stringify(name)}]]`);
    return r.result === 1;
  }, 30000, 500);
  await sb.remove(T.alice, S.alpha, `${name}.md`);
  t.diagnostic(`measure: headless runtime indexes an API write = ${seen.value ? seen.seconds.toFixed(1) + " s" : "not within 30 s"}`);
  assert.ok(seen.value, "the headless runtime did not index the write within 30 s (the render path waits and falls back to a reboot for this reason)");
});

test("execution: *.plug.js files load as plugs in every client (section 3)", (t) => {
  t.skip("not asserted: needs a plug bundle; the statement rests on client/space.ts at the tag");
});

test("execution: scripts run under a CPU budget and can be quarantined per browser (section 1)", (t) => {
  t.skip("not asserted: runaway control, not access control; rests on client/space_lua/budget.ts at the tag");
});
