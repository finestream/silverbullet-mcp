// The render tools (docs/architecture.md, section 5; docs/security.md,
// section 12) against the compose test instance. gamma is the clean space
// with the Runtime API (alice write + Runtime API, bob read); alpha holds code
// on purpose, so rendering is blocked there; beta is bob's, alice has nothing.

import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { startServer, connect, BEARERS, DEFAULT_ACCESS_LIST, unique, type RunningServer, type McpClient } from "./harness.ts";
import { sb, T, SB_URL } from "../lib/env.ts";

const RENDER_ACCESS =
  DEFAULT_ACCESS_LIST +
  `
alice gamma /          rwx
alice gamma Projects/  rwdx
alice gamma index      r
alice alpha Rendered   rx
bob   gamma /          rx
carol beta  /          rx
`;

let server: RunningServer;
let alice: McpClient;
let bob: McpClient;
let carol: McpClient;
/** Pages the tests create in gamma, removed as admin at the end whatever happened. */
const created: string[] = [];
const track = (name: string) => {
  created.push(`${name}.md`);
  return name;
};

before(async () => {
  server = await startServer({ accessList: RENDER_ACCESS });
  alice = await connect(server.url, BEARERS.alice);
  bob = await connect(server.url, BEARERS.bob);
  carol = await connect(server.url, BEARERS.carol);
});

after(async () => {
  await Promise.all([alice?.close(), bob?.close(), carol?.close()]);
  await server?.stop();
  for (const f of created) await sb.remove(T.admin, "gamma", f);
});

const PNG = "89504e470d0a1a0a";
const pngOf = (data: string) => Buffer.from(data, "base64");

test("render-note: expressions, the page context, a query over tasks, a template include and a transclusion are evaluated; no revision", async () => {
  const r = await alice.call("render-note", { space: "gamma", filename: "Rendered" });
  assert.equal(r.isError, false, r.text);
  const md = r.data!.content as string;
  assert.match(md, /^---\nstatus: draft\n---\n/, "the frontmatter is kept");
  assert.match(md, /Sum: 2\n/, "${1 + 1} renders 2");
  assert.match(md, /Current page: Rendered\n/, "_CTX.currentPage is set for the render");
  assert.match(md, /\* \[ \] \[\[Projects\/One@\d+\]\] Task one of project one/, "the task query rendered through templates.taskItem");
  assert.match(md, /\* \[x\] \[\[Projects\/One@\d+\]\] Task two of project one/);
  assert.match(md, /\* \[ \] \[\[Projects\/Two@\d+\]\] Task of project two/);
  assert.match(md, /## Projects\n(?:[^\n]*\n)*?Projects\/One\n(?:[^\n]*\n)*?Projects\/Two\n/, "a select of plain values renders as text, one per line");
  assert.match(md, /marker-gamma-one/, "the transclusion is expanded");
  assert.doesNotMatch(md, /\$\{/, "no directive is left");
  assert.equal("revision" in r.data!, false, "render-note returns no revision");
  assert.deepEqual(r.data!.warnings, []);
  assert.equal(r.text, md);
});

test("render-note: a query with rows renders as an HTML table (SilverBullet's own output, left as it is)", async () => {
  const name = track(unique("Projects/Table"));
  const c = await alice.call("create-note", { space: "gamma", filename: name, content: 'Rows: ${query[[from p = index.tag "project" order by p.name select {Name = p.name, Status = p.status}]]}\n' });
  assert.equal(c.isError, false, c.text);
  const r = await alice.call("render-note", { space: "gamma", filename: name });
  assert.equal(r.isError, false, r.text);
  assert.match(r.data!.content, /<table>.*<th>Name<\/th>.*Projects\/One.*<\/table>/s);
});

test("screenshot-note: a valid PNG as MCP image content; selector clips; an unknown selector is an error that says so", async () => {
  const full = await alice.call("screenshot-note", { space: "gamma", filename: "Rendered" });
  assert.equal(full.isError, false, full.text);
  assert.equal(full.data!.mimeType, "image/png");
  assert.ok(full.data!.width > 0 && full.data!.height > 0, "a size");
  assert.equal(full.image?.mimeType, "image/png", "an image content block");
  const png = pngOf(full.image!.data);
  assert.equal(png.subarray(0, 8).toString("hex"), PNG, "the PNG signature");
  assert.equal(png.readUInt32BE(16), full.data!.width);
  assert.equal(png.readUInt32BE(20), full.data!.height);
  assert.equal(png.length, full.data!.bytes);
  assert.equal("revision" in full.data!, false);

  const clipped = await alice.call("screenshot-note", { space: "gamma", filename: "Rendered", selector: "#sb-editor" });
  assert.equal(clipped.isError, false, clipped.text);
  assert.ok(clipped.data!.height <= full.data!.height, "clipped to the editor");
  assert.equal(clipped.data!.selector, "#sb-editor");

  const none = await alice.call("screenshot-note", { space: "gamma", filename: "Rendered", selector: "#no-such-element" });
  assert.equal(none.isError, true);
  assert.match(none.text, /^Rendering failed: no visible element matches the selector/);
});

test("refusals: no x is refused by the access list; another file type by the file-type rule; a missing page is SilverBullet's 404", async () => {
  const noX = await alice.call("render-note", { space: "gamma", filename: "index" });
  assert.equal(noX.isError, true);
  assert.match(noX.text, /^Denied by the access list: user "alice" has no "x" on gamma\/index \(effective rights: r\)/);
  const shot = await alice.call("screenshot-note", { space: "gamma", filename: "index" });
  assert.match(shot.text, /has no "x"/);
  const csv = await alice.call("render-note", { space: "gamma", filename: "Projects/data.csv" });
  assert.match(csv.text, /^Refused by the file-type rule: only pages \(\.md\) are rendered/);
  const missing = await alice.call("render-note", { space: "gamma", filename: "Projects/Nope" });
  assert.match(missing.text, /^SilverBullet refused: SilverBullet has no gamma\/Projects\/Nope\.md \(404\)/);
});

test("refusals: a read-only member with x gets SilverBullet's 403 with the hint about Write and the Runtime API", async () => {
  const r = await bob.call("render-note", { space: "gamma", filename: "Rendered" });
  assert.equal(r.isError, true);
  assert.match(r.text, /^SilverBullet refused: SilverBullet refused the Runtime API \(403\) for space gamma: .*needs Write access to the space and the Runtime API granted to the user in the space's access grid.*A read-only member cannot render\./);
  const shot = await bob.call("screenshot-note", { space: "gamma", filename: "Rendered" });
  assert.match(shot.text, /Runtime API \(403\)/);
});

test("refusals: a user cannot render a page of a space SilverBullet does not grant, whatever the access list says", async () => {
  // carol has x on beta in the list; SilverBullet grants her nothing there.
  const r = await carol.call("render-note", { space: "beta", filename: "Secret" });
  assert.equal(r.isError, true);
  assert.match(r.text, /^SilverBullet refused: SilverBullet refused access \(403/);
  assert.doesNotMatch(r.text, /marker-beta-secret/);
});

test("scan findings block rendering in that space only; read and write there still work", async () => {
  const blocked = await alice.call("render-note", { space: "alpha", filename: "Rendered" });
  assert.equal(blocked.isError, true);
  assert.match(blocked.text, /^Rendering is blocked in space "alpha": the last scan found \d+ finding\(s\) on \d+ page\(s\) with code outside CONFIG and Library\/.*report page "MCP Server"/);
  assert.match((await alice.call("screenshot-note", { space: "alpha", filename: "Rendered" })).text, /^Rendering is blocked in space "alpha"/);
  const read = await alice.call("read-note", { space: "alpha", filename: "Rendered" });
  assert.equal(read.isError, false, "read still works");
  const page = unique("Agent/Render block");
  const write = await alice.call("create-note", { space: "alpha", filename: page, content: "still writable\n" });
  assert.equal(write.isError, false, write.text);
  await alice.call("delete-note", { space: "alpha", filename: page });
  const ok = await alice.call("render-note", { space: "gamma", filename: "Rendered" });
  assert.equal(ok.isError, false, "gamma, which is clean, renders");
  const lines = server.logs.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((l) => l?.event === "request" && l.tool === "render-note" && l.space === "alpha");
  assert.equal(lines[lines.length - 1].outcome, "refused:render-block");
});

test("write then render: the index wait makes a page written through the server visible to the next render; a delete too", async () => {
  const name = track(unique("Projects/Written"));
  const c = await alice.call("create-note", { space: "gamma", filename: name, content: "---\ntags: project\nstatus: active\n---\nWritten.\n\n* [ ] task-of-written-page\n" });
  assert.equal(c.isError, false, c.text);
  const r = await alice.call("render-note", { space: "gamma", filename: "Rendered" });
  assert.equal(r.isError, false, r.text);
  assert.match(r.data!.content, /task-of-written-page/, "the task of the new page is in the query result");
  assert.match(r.data!.content, new RegExp(`## Projects\\n.*${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "s"));
  assert.deepEqual(r.data!.warnings, []);
  assert.ok(typeof r.data!.indexWaitMs === "number");

  const d = await alice.call("delete-note", { space: "gamma", filename: name });
  assert.equal(d.isError, false, d.text);
  const again = await alice.call("render-note", { space: "gamma", filename: "Rendered" });
  assert.doesNotMatch(again.data!.content, /task-of-written-page/, "the deleted page is gone from the index");
  assert.deepEqual(again.data!.warnings, []);
});

test("write then render: with MCP_INDEX_WAIT=0 the fallback is system.reboot() on the user's runtime, and the render shows the new content", async () => {
  const s = await startServer({ accessList: RENDER_ACCESS, env: { MCP_INDEX_WAIT: "0" } });
  const a = await connect(s.url, BEARERS.alice);
  const name = track(unique("Projects/Rebooted"));
  try {
    const warm = await a.call("render-note", { space: "gamma", filename: "Rendered" });
    assert.equal(warm.isError, false, warm.text);
    const c = await a.call("create-note", { space: "gamma", filename: name, content: "---\ntags: project\n---\n* [ ] task-after-reboot\n" });
    assert.equal(c.isError, false, c.text);
    const r = await a.call("render-note", { space: "gamma", filename: "Rendered" });
    assert.equal(r.isError, false, r.text);
    assert.equal(r.data!.rebooted, true, "the runtime was rebooted");
    assert.match(r.data!.content, /task-after-reboot/, "the rebooted runtime indexed the new page");
    assert.ok(s.logs.some((l) => l.includes('"event":"render.reboot"') && l.includes(name)), "the reboot is logged with the page");
    const next = await a.call("render-note", { space: "gamma", filename: "Rendered" });
    assert.equal(next.data!.rebooted, false, "one reboot per batch of writes");
  } finally {
    await a.close();
    await s.stop();
  }
});

test("queue: five parallel calls on one runtime each render their own page context; screenshots interleave", async () => {
  const names = [1, 2, 3, 4, 5].map((i) => track(unique(`Projects/Parallel ${i}`)));
  for (const n of names) {
    const c = await alice.call("create-note", { space: "gamma", filename: n, content: `Me: \${_CTX.currentPage.name}\n` });
    assert.equal(c.isError, false, c.text);
  }
  const results = await Promise.all([
    ...names.map((n) => alice.call("render-note", { space: "gamma", filename: n })),
    alice.call("screenshot-note", { space: "gamma", filename: "Rendered", selector: "#sb-editor" }),
    alice.call("screenshot-note", { space: "gamma", filename: names[0], selector: "#sb-editor" }),
  ]);
  results.forEach((r, i) => {
    assert.equal(r.isError, false, `call ${i}: ${r.text}`);
    if (i < names.length) assert.equal(r.data!.content, `Me: ${names[i]}\n`, `render ${i} shows its own page`);
    else assert.equal(r.data!.mimeType, "image/png");
  });
  const queued = results.map((r) => r.data!.queuedMs as number);
  assert.ok(queued.some((q) => q > 0), `calls waited for one another: ${queued.join(", ")}`);
});

test("report page: the (user, space) runtimes used since start are listed", async () => {
  await server.rescan();
  const report = await alice.call("read-note", { space: "gamma", filename: "MCP Server", limit: 100_000 });
  assert.equal(report.isError, false, report.text);
  assert.match(report.data!.content, /## Runtimes used in this space since start \(1\)\n[^|]*\| User \| First used \| Last used \| Calls \| Reboots \|\n\|---\|---\|---\|---\|---\|\n\| `alice` \| \S+ \| \S+ \| \d+ \| \d+ \|/);
});

test("timeout: a render that cannot finish within MCP_RENDER_TIMEOUT is refused, not left hanging", async () => {
  const s = await startServer({ accessList: RENDER_ACCESS, env: { MCP_RENDER_TIMEOUT: "0" } });
  const a = await connect(s.url, BEARERS.alice);
  try {
    const r = await a.call("render-note", { space: "gamma", filename: "Rendered" });
    assert.equal(r.isError, true);
    assert.match(r.text, /^The render did not complete within \d+ s \(MCP_RENDER_TIMEOUT\)\./);
  } finally {
    await a.close();
    await s.stop();
  }
});

test("read-note and the other source tools never touch /.runtime/*; the render tools do", async () => {
  // A recording proxy between the server and SilverBullet.
  const hits: string[] = [];
  const proxy: Server = createServer(async (req, res) => {
    hits.push(`${req.method} ${req.url}`);
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string" && !["host", "connection", "content-length", "transfer-encoding"].includes(k)) headers[k] = v;
    const r = await fetch(`${SB_URL}${req.url}`, { method: req.method, headers, body: chunks.length ? Buffer.concat(chunks) : undefined });
    const body = Buffer.from(await r.arrayBuffer());
    const out: Record<string, string> = {};
    r.headers.forEach((v, k) => { if (!["content-encoding", "transfer-encoding", "content-length"].includes(k)) out[k] = v; });
    res.writeHead(r.status, { ...out, "content-length": String(body.length) });
    res.end(body);
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const address = proxy.address() as { port: number };
  const s = await startServer({ accessList: RENDER_ACCESS, env: { SB_URL: `http://127.0.0.1:${address.port}` } });
  const a = await connect(s.url, BEARERS.alice);
  try {
    hits.length = 0;
    for (const [tool, args] of [
      ["read-note", { space: "gamma", filename: "Rendered" }],
      ["read-multiple-notes", { space: "gamma", filenames: ["Rendered", "Projects/One"] }],
      ["list-notes", { space: "gamma" }],
      ["search-notes", { space: "gamma", query: "marker" }],
      ["list-spaces", {}],
      ["edit-note", { space: "gamma", filename: "Rendered", expectedRevision: '"sha256:stale"', edits: [{ oldText: "Sum", newText: "Sum" }] }],
    ] as Array<[string, Record<string, unknown>]>) {
      const r = await a.call(tool, args);
      assert.ok(tool === "edit-note" || !r.isError, `${tool}: ${r.text}`);
    }
    assert.ok(hits.length > 0, "the proxy saw the calls");
    assert.deepEqual(hits.filter((h) => h.includes("/.runtime/")), [], `no Runtime API call for the source tools; saw:\n${hits.join("\n")}`);
    hits.length = 0;
    const r = await a.call("render-note", { space: "gamma", filename: "Rendered" });
    assert.equal(r.isError, false, r.text);
    assert.ok(hits.some((h) => h === "POST /gamma/.runtime/lua_script"), `render-note goes through the Runtime API; saw:\n${hits.join("\n")}`);
  } finally {
    await a.close();
    await s.stop();
    proxy.close();
  }
});
