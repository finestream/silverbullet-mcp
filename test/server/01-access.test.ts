// Authentication and the access list (docs/security.md, sections 3 and 4),
// against the compose test instance. Fixtures: alice (SilverBullet write on
// alpha, default space alpha), bob (read on alpha, write on beta, default
// beta), carol (alice's token: nothing on beta, her default space).

import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, connect, BEARERS, DEFAULT_ACCESS_LIST, type RunningServer, type McpClient } from "./harness.ts";

let server: RunningServer;
let alice: McpClient;
let bob: McpClient;
let carol: McpClient;

before(async () => {
  server = await startServer({
    accessList: DEFAULT_ACCESS_LIST + "\n@ops * Projects/ -\n@readers * Projects/Two r\nbob alpha Projects/Two rw\nbob alpha Outside -\nalice beta / rw\n",
    credentials: undefined,
  });
  alice = await connect(server.url, BEARERS.alice);
  bob = await connect(server.url, BEARERS.bob);
  carol = await connect(server.url, BEARERS.carol);
});

after(async () => {
  await Promise.all([alice?.close(), bob?.close(), carol?.close()]);
  await server?.stop();
});

test("auth: no bearer, a wrong bearer and a bearer in the query string are refused with 401", async () => {
  for (const headers of [{}, { Authorization: "Bearer nope" }, { Authorization: "Basic abc" }]) {
    const r = await fetch(`${server.url}/mcp`, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    assert.equal(r.status, 401);
    assert.match(r.headers.get("www-authenticate") ?? "", /Bearer/);
  }
  const q = await fetch(`${server.url}/mcp?token=${BEARERS.alice}`, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
  assert.equal(q.status, 401, "the bearer is read from the header only");
});

test("auth: GET and DELETE on /mcp are 405 (stateless); /healthz answers without a bearer", async () => {
  assert.equal((await fetch(`${server.url}/mcp`)).status, 405);
  assert.equal((await fetch(`${server.url}/mcp`, { method: "DELETE" })).status, 405);
  const h = await fetch(`${server.url}/healthz`);
  assert.equal(h.status, 200);
  const body = (await h.json()) as { ok: boolean; spaces: Record<string, { guarded: boolean; transform: string }> };
  assert.equal(body.ok, true);
  assert.equal(body.spaces.alpha.guarded, true);
  assert.equal(body.spaces.alpha.transform, "present");
});

test("tools: the v1-compatible tool names, no search-replace-note", async () => {
  const names = await alice.tools();
  assert.deepEqual(names.sort(), ["create-note", "delete-note", "edit-note", "list-notes", "list-spaces", "read-multiple-notes", "read-note", "search-notes"]);
});

test("access: deny by default: a page without any entry is refused by the access list, not by SilverBullet", async () => {
  const s = await startServer({ accessList: "alice alpha Projects/ r\n" });
  const a = await connect(s.url, BEARERS.alice);
  try {
    const r = await a.call("read-note", { filename: "Rendered" });
    assert.equal(r.isError, true);
    assert.match(r.text, /^Denied by the access list: user "alice" has no "r" on alpha\/Rendered \(effective rights: -\)/);
    const ok = await a.call("read-note", { filename: "Projects/One" });
    assert.equal(ok.isError, false, ok.text);
    assert.match(ok.data!.revision, /^"sha256:/);
  } finally {
    await a.close();
    await s.stop();
  }
});

test("access: CONFIG and Library/ are absent from listings and search, and refused on read", async () => {
  const list = await alice.call("list-notes", { limit: 500 });
  assert.equal(list.isError, false, list.text);
  const names = (list.data!.notes as Array<{ name: string }>).map((n) => n.name);
  assert.ok(names.includes("Rendered.md"));
  assert.ok(!names.includes("CONFIG.md"), "CONFIG is absent");
  assert.ok(!names.some((n) => n.startsWith("Library/")), "Library/ is absent");
  const search = await alice.call("search-notes", { query: "agentTest|mylib_fn", maxResults: 100 });
  assert.equal(search.isError, false, search.text);
  const found = (search.data!.results as Array<{ filename: string }>).map((r) => r.filename);
  assert.ok(!found.includes("CONFIG.md") && !found.some((n) => n.startsWith("Library/")), `found ${found.join(", ")}`);
  const read = await alice.call("read-note", { filename: "Library/Mine" });
  assert.equal(read.isError, true);
  assert.match(read.text, /Denied by the access list/);
});

test("access: the most specific path wins; a user entry beats group entries; between groups `-` wins", async () => {
  // bob: @agents gives r on /, rw on Projects/; his own entry gives rw on Projects/Two (SilverBullet: read only on alpha).
  const two = await bob.call("read-note", { space: "alpha", filename: "Projects/Two" });
  assert.equal(two.isError, false, two.text);
  const write = await bob.call("create-note", { space: "alpha", filename: "Projects/Two", content: "x", overwrite: true });
  assert.equal(write.isError, true);
  assert.match(write.text, /^SilverBullet refused: .*403/, "the access list grants w, SilverBullet is the ceiling: its 403 is passed through");

  const s = await startServer({ credentials: undefined, accessList: DEFAULT_ACCESS_LIST + "@ops * Projects/ -\n@readers * Projects/Two r\n" });
  try {
    // alice in agents and ops: `-` from ops wins on Projects/.
    const s2 = await startServer({ accessList: DEFAULT_ACCESS_LIST + "@ops * Projects/ -\n", credentials: credentialsWithGroups({ alice: "agents,ops" }) });
    const a = await connect(s2.url, BEARERS.alice);
    try {
      const r = await a.call("read-note", { filename: "Projects/One" });
      assert.equal(r.isError, true);
      assert.match(r.text, /effective rights: -/);
      const listed = await a.call("list-notes", { namePattern: "^Projects/" });
      assert.equal(listed.data!.total, 0, "denied pages are absent from listings");
    } finally {
      await a.close();
      await s2.stop();
    }
  } finally {
    await s.stop();
  }
});

test("access: an entry for a space SilverBullet does not grant has no effect; SilverBullet's refusal is passed through", async () => {
  // alice has `rw` on beta in the list, but SilverBullet gives her nothing there.
  const r = await alice.call("read-note", { space: "beta", filename: "Secret" });
  assert.equal(r.isError, true);
  assert.match(r.text, /^SilverBullet refused: SilverBullet refused access \(403/);
  const spaces = await alice.call("list-spaces");
  assert.deepEqual((spaces.data!.spaces as Array<{ space: string }>).map((s) => s.space), ["alpha"], "list-spaces shows only what SilverBullet grants");
});

test("access: two users see different listings of the same space; carol sees nothing in her default space", async () => {
  const a = await alice.call("list-notes", { limit: 500 });
  const b = await bob.call("list-notes", { space: "alpha", limit: 500 });
  const an = (a.data!.notes as Array<{ name: string }>).map((n) => n.name);
  const bn = (b.data!.notes as Array<{ name: string }>).map((n) => n.name);
  assert.ok(an.includes("Projects/One.md") && bn.includes("Projects/One.md"));
  assert.ok(an.includes("Outside.md"), "alice sees Outside");
  assert.ok(!bn.includes("Outside.md"), "bob's own `-` on Outside hides it from his listing");
  const c = await carol.call("list-notes");
  assert.equal(c.isError, true);
  assert.match(c.text, /SilverBullet refused/);
});

test("access: delete needs d; alice has it under Agent/ only", async () => {
  const page = "Agent/To delete";
  const created = await alice.call("create-note", { filename: page, content: "temporary" });
  assert.equal(created.isError, false, created.text);
  const denied = await alice.call("delete-note", { filename: "Projects/One" });
  assert.equal(denied.isError, true);
  assert.match(denied.text, /has no "d" on alpha\/Projects\/One \(effective rights: rw\)/);
  const stale = await alice.call("delete-note", { filename: page, expectedRevision: '"sha256:stale"' });
  assert.equal(stale.isError, true);
  assert.match(stale.text, /Revision conflict/);
  const deleted = await alice.call("delete-note", { filename: page, expectedRevision: created.data!.revision });
  assert.equal(deleted.isError, false, deleted.text);
  const gone = await alice.call("read-note", { filename: page });
  assert.match(gone.text, /SilverBullet has no alpha\/Agent\/To delete.md \(404\)/);
});

test("log: every tool call is one request line with user, space, tool and outcome, without contents", async () => {
  await alice.call("read-note", { filename: "CONFIG" });
  const lines = server.logs.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((l) => l?.event === "request");
  const last = lines[lines.length - 1];
  assert.equal(last.user, "alice");
  assert.equal(last.space, "alpha");
  assert.equal(last.tool, "read-note");
  assert.equal(last.outcome, "refused:access-list");
  assert.ok(typeof last.ms === "number");
  assert.ok(!server.logs.some((l) => l.includes(BEARERS.alice)), "no bearer in the log");
});

import { credentialsFile } from "./harness.ts";
function credentialsWithGroups(groups: Record<string, string>) {
  return credentialsFile({ groups });
}
