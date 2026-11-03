// The Runtime API as the render path uses it (docs/architecture.md, "Findings
// from the spike"; docs/security.md, section 12): rendering, its two gaps in
// 2.12.1, the best-effort write guard, runtime identity, screenshots.

import test from "node:test";
import assert from "node:assert/strict";
import { sb, T, S } from "../lib/env.ts";
import { luaString, renderScript } from "../lib/lua.ts";

test("runtime: a fresh runtime boots on the first call (reset through the admin API; cold start measured)", async (t) => {
  await sb.admin.resetRuntimes(T.admin);
  const r = await sb.lua(T.alice, S.alpha, "return 1");
  assert.equal(r.status, 200, r.raw);
  assert.equal(r.result, 1);
  t.diagnostic(`measure: runtime cold start (reset, then first call) = ${r.ms} ms`);
  const warm = await sb.lua(T.alice, S.alpha, "return 1");
  t.diagnostic(`measure: runtime warm call = ${warm.ms} ms`);
});

test("render: markdown.expandMarkdown evaluates expressions, queries, templates and transclusions", async (t) => {
  const r = await sb.lua(T.alice, S.alpha, renderScript("Rendered"));
  assert.equal(r.status, 200, r.raw);
  const md = String(r.result);
  assert.ok(md.includes("Sum: 3"), "${1 + 2} evaluated");
  assert.ok(md.includes("Current page: Rendered"), "_CTX.currentPage set by the shim");
  assert.ok(md.includes("Projects/One") && md.includes("parked"), "query rows present");
  assert.ok(md.includes("* [[Projects/One]] is active"), "template evaluated");
  assert.ok(md.includes("marker-alpha-one"), "transclusion expanded");
  const again = await sb.lua(T.alice, S.alpha, renderScript("Rendered"));
  t.diagnostic(`measure: render of a small page, warm = ${again.ms} ms`);
});

test("[watch] render: _CTX is not set inside markdown.expandMarkdown (the render script sets a shim)", async () => {
  const r = await sb.lua(T.alice, S.alpha, `return markdown.expandMarkdown("Page: \${_CTX.currentPage.name}")`);
  assert.equal(r.status, 200, r.raw);
  assert.ok(!String(r.result).includes("Page: Rendered"), `_CTX is now set: ${r.result}`);
});

test("[watch] render: expandMarkdown(text, {pageName}) is not available (the edge release adds it; the shim then goes)", async () => {
  const r = await sb.lua(
    T.alice,
    S.alpha,
    `local ok, res = pcall(markdown.expandMarkdown, "Page: \${_CTX.currentPage.name}", {pageName = "Rendered"})
return {ok = ok, res = tostring(res)}`,
  );
  const { res } = r.result as { ok: boolean; res: string };
  assert.ok(!res.includes("Page: Rendered"), `the pageName option works now: ${res}`);
});

test("[watch] render: query results come back as HTML tables, not Markdown tables", async () => {
  const r = await sb.lua(T.alice, S.alpha, renderScript("Rendered"));
  assert.ok(String(r.result).includes("<table>"), "query results are no longer HTML tables; the render path may convert nothing now");
});

test("guard: a render of a page whose expression writes does not write when space.write* is shadowed", async () => {
  const r = await sb.lua(T.alice, S.alpha, renderScript("Side effect"));
  assert.equal(r.status, 200, r.raw);
  assert.ok(String(r.result).includes("rendering is read-only"), "the shadowed call rendered as an error");
  assert.equal((await sb.read(T.alice, S.alpha, "Side effect output.md")).status, 404, "nothing was written");
});

test("[watch] guard: js.window.fetch from a page can still write as the user (the guard is best-effort)", async () => {
  const r = await sb.lua(
    T.alice,
    S.alpha,
    `local r = js.window.fetch("/alpha/.fs/Bypass.md", {method = "PUT", body = "x", headers = {["X-Sync-Mode"] = "true"}})
return r.status`,
  );
  const written = (await sb.read(T.alice, S.alpha, "Bypass.md")).status === 200;
  await sb.remove(T.alice, S.alpha, "Bypass.md");
  assert.ok(written, `the bypass no longer writes (fetch returned ${r.result}): a read-only runtime may exist now`);
});

test("isolation: the runtime runs as the token's user; the Runtime API requires Write", async () => {
  const cross = await sb.lua(T.alice, S.alpha, `local r = js.window.fetch("/beta/.fs/Secret.md", {headers = {["X-Sync-Mode"] = "true"}}) return r.status`);
  assert.equal(cross.result, 401, "alice's alpha runtime cannot read beta");
  assert.equal((await sb.lua(T.alice, S.beta, "return 1")).status, 403, "alice gets no runtime on beta");
  assert.equal((await sb.lua(T.bob, S.alpha, "return 1")).status, 403, "a read-only member gets no runtime");
  const bob = await sb.lua(T.bob, S.beta, 'return space.readPage("Secret")');
  assert.ok(String(bob.result).includes("marker-beta-secret"), `bob's runtime reads beta: ${bob.raw}`);
});

test("screenshot: navigate, then capture; ?selector= clips to an element", async (t) => {
  await sb.lua(T.alice, S.alpha, `editor.navigate(${luaString("Rendered")})`);
  const full = await sb.screenshot(T.alice, S.alpha);
  assert.equal(full.status, 200);
  assert.ok(full.size && full.size.width > 0 && full.size.height > 0, "a PNG with a size");
  t.diagnostic(`measure: screenshot, warm = ${full.ms} ms, ${full.size?.width}x${full.size?.height}, ${full.png.length} B`);
  const clipped = await sb.screenshot(T.alice, S.alpha, "?selector=%23sb-editor");
  assert.equal(clipped.status, 200);
  assert.ok(clipped.size && clipped.size.height <= full.size!.height, "the clipped image is no taller than the viewport");
});

test("[watch] screenshot: ?fullPage=1 is ignored (same image as the viewport)", async () => {
  const full = await sb.screenshot(T.alice, S.alpha);
  const fullPage = await sb.screenshot(T.alice, S.alpha, "?fullPage=1");
  assert.equal(fullPage.status, 200);
  assert.deepEqual(fullPage.size, full.size, "fullPage now changes the image; the screenshot tool can offer it");
});
