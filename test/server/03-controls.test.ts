// The controls that act on the whole server or a whole space: refuse to serve
// on an invalid allowlist or a missing transform (docs/security.md, section 9),
// the per-space render block on scan findings (section 7), the report page
// (section 8), the quarantine mode and the CLI scan.

import test, { after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startServer, connect, BEARERS, DEFAULT_ACCESS_LIST, credentialsFile, unique } from "./harness.ts";
import { sb, T, SB_URL } from "../lib/env.ts";
import { configPage } from "../lib/transform.ts";
import { SHIPPED_ALLOWLIST, compileAllowlist } from "../../src/filter/allowlist.ts";
import { checkPage } from "../../src/filter/filter.ts";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const BETA_ACCESS = DEFAULT_ACCESS_LIST + "bob beta / rw\n";

after(async () => {
  // Whatever a test left behind: beta's CONFIG with the shipped transform.
  await sb.write(T.admin, "beta", "CONFIG.md", configPage("shipped"));
});

test("refuse to serve: an allowlist entry that covers a never-allowed name refuses every tool but list-spaces; /healthz says so", async () => {
  const server = await startServer({ allowlist: [...SHIPPED_ALLOWLIST, "template.*"] });
  const alice = await connect(server.url, BEARERS.alice);
  try {
    const r = await alice.call("read-note", { filename: "Rendered" });
    assert.equal(r.isError, true);
    assert.match(r.text, /^Refusing to serve: the allowlist file is missing or invalid \(.*"template\.\*" covers the never-allowed name "template\.new"/);
    assert.equal((await alice.call("create-note", { filename: "Projects/x", content: "x" })).isError, true);
    const spaces = await alice.call("list-spaces");
    assert.equal(spaces.isError, false, "list-spaces still answers");
    assert.match((spaces.data!.spaces as Array<{ refusal: string }>)[0].refusal, /Refusing to serve/);
    assert.equal((await fetch(`${server.url}/healthz`)).status, 503, "not healthy while refusing to serve");
  } finally {
    await alice.close();
    await server.stop();
  }
});

test("refuse to serve: a space whose CONFIG lacks the transform is refused; the other space is served; a fix is seen on SIGHUP", async () => {
  await sb.write(T.admin, "beta", "CONFIG.md", configPage("none"));
  const server = await startServer({ accessList: BETA_ACCESS });
  const bob = await connect(server.url, BEARERS.bob);
  try {
    const r = await bob.call("read-note", { filename: "Secret" });
    assert.equal(r.isError, true);
    assert.match(r.text, /^Refusing to serve space "beta": the index-time transform is missing from CONFIG or differs from the shipped block\. Operator: add the block/);
    const alpha = await bob.call("read-note", { space: "alpha", filename: "Rendered" });
    assert.equal(alpha.isError, false, alpha.text);
    await sb.write(T.admin, "beta", "CONFIG.md", configPage("shipped"));
    await server.rescan();
    const again = await bob.call("read-note", { filename: "Secret" });
    assert.equal(again.isError, false, again.text);
  } finally {
    await bob.close();
    await server.stop();
  }
});

test("refuse to serve: a malformed access list refuses every tool (a dropped line could be a denial)", async () => {
  const server = await startServer({ accessList: DEFAULT_ACCESS_LIST + "@agents * Library/\n" });
  const alice = await connect(server.url, BEARERS.alice);
  try {
    const r = await alice.call("read-note", { filename: "Rendered" });
    assert.equal(r.isError, true);
    assert.match(r.text, /^Refusing to serve: the access list file is missing or invalid \(line \d+: expected/);
    assert.equal((await fetch(`${server.url}/healthz`)).status, 503);
  } finally {
    await alice.close();
    await server.stop();
  }
});

test("report page: a page name or a detail with a directive cannot make the report page live", async () => {
  const evil = 'Evil ${space.readPage("CONFIG")}';
  await sb.write(T.admin, "beta", `${evil}.md`, "Body with `${1}` and ${space.readPage(\"CONFIG\")}\n");
  const server = await startServer({ accessList: BETA_ACCESS });
  const bob = await connect(server.url, BEARERS.bob);
  try {
    const report = await bob.call("read-note", { filename: "MCP Server", limit: 100_000 });
    assert.equal(report.isError, false, report.text);
    const verdict = checkPage(report.data!.content, compileAllowlist([]));
    assert.equal(verdict.directives, 0, "no live directive in the report");
    assert.ok(verdict.ok);
    assert.match(report.data!.content, /Evil/);
  } finally {
    await sb.remove(T.admin, "beta", `${evil}.md`);
    await bob.close();
    await server.stop();
  }
});

test("refuse to serve: a space the scan user cannot reach is refused as unguarded", async () => {
  const server = await startServer({ credentials: credentialsFile({ scan: false }), accessList: BETA_ACCESS });
  const bob = await connect(server.url, BEARERS.bob);
  try {
    const r = await bob.call("read-note", { filename: "Secret" });
    assert.equal(r.isError, true);
    assert.match(r.text, /^Refusing to serve space "beta": it is not guarded \(the credentials file has no line for the technical user "scan"\)/);
  } finally {
    await bob.close();
    await server.stop();
  }
});

test("scan findings: rendering is blocked in the space with findings only; read and write are served; a cleaned page lifts the block", async () => {
  const planted = unique("Planted");
  await sb.write(T.admin, "beta", `${planted}.md`, 'Leak: ${space.readPage("CONFIG")}\n');
  const server = await startServer({ accessList: BETA_ACCESS });
  const bob = await connect(server.url, BEARERS.bob);
  try {
    const spaces = await bob.call("list-spaces");
    const byName = Object.fromEntries((spaces.data!.spaces as Array<{ space: string; renderBlocked: string | null; refusal: string | null }>).map((s) => [s.space, s]));
    assert.match(byName.beta.renderBlocked ?? "", /^Rendering is blocked in space "beta": the last scan found 1 finding\(s\) on 1 page\(s\)/);
    assert.match(byName.alpha.renderBlocked ?? "", /^Rendering is blocked in space "alpha"/, "alpha's seed pages hold code on purpose");
    assert.equal(byName.beta.refusal, null, "read and write are still served");

    const read = await bob.call("read-note", { filename: planted });
    assert.equal(read.isError, false, read.text);
    const report = await bob.call("read-note", { filename: "MCP Server" });
    assert.equal(report.isError, false, report.text);
    assert.match(report.data!.content, new RegExp(`\\| \\[\\[${planted}\\]\\] \\| 1 \\| \`denied-name\` \\| \`space.readPage\` \\|`));
    assert.match(report.data!.content, /Rendering: \*\*blocked\*\*/);

    const still = await bob.call("edit-note", { filename: planted, expectedRevision: read.data!.revision, edits: [{ oldText: "Leak", newText: "Still a leak" }] });
    assert.equal(still.isError, true, "a page that still has code is refused");
    assert.match(still.text, /Refused by the write filter/);

    const cleaned = await bob.call("edit-note", { filename: planted, expectedRevision: read.data!.revision, edits: [{ oldText: '${space.readPage("CONFIG")}', newText: "nothing" }] });
    assert.equal(cleaned.isError, false, cleaned.text);
    const after = await bob.call("list-spaces");
    const beta = (after.data!.spaces as Array<{ space: string; renderBlocked: string | null }>).find((s) => s.space === "beta")!;
    assert.equal(beta.renderBlocked, null, "the cleaned page's findings are dropped at once");

    await bob.call("delete-note", { filename: planted }); // no d for bob: cleaned up as admin
  } finally {
    await sb.remove(T.admin, "beta", `${planted}.md`);
    await bob.close();
    await server.stop();
  }
});

test("scan: files that are not pages are findings unless allowed by path; the allow entry silences them", async () => {
  // alpha holds code.lua from the seeds.
  const blocked = await startServer();
  const alice = await connect(blocked.url, BEARERS.alice);
  try {
    const s = (await alice.call("list-spaces")).data!.spaces as Array<{ space: string; renderBlocked: string }>;
    assert.match(s[0].renderBlocked, /1 file\(s\) that are not pages/, "code.lua from the seeds");
  } finally {
    await alice.close();
    await blocked.stop();
  }
  const allowed = await startServer({ allowedFiles: "alpha code.lua\n" });
  const alice2 = await connect(allowed.url, BEARERS.alice);
  try {
    const s = (await alice2.call("list-spaces")).data!.spaces as Array<{ space: string; renderBlocked: string }>;
    assert.doesNotMatch(s[0].renderBlocked, /file\(s\) that are not pages/);
  } finally {
    await alice2.close();
    await allowed.stop();
  }
});

test("CLI scan: `--scan` reports per space and exits 1 with findings; quarantine mode neutralises a page and tags it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sbmcp-cli-"));
  writeFileSync(join(dir, "credentials"), credentialsFile());
  writeFileSync(join(dir, "access-list"), BETA_ACCESS);
  writeFileSync(join(dir, "allowlist"), SHIPPED_ALLOWLIST.join("\n") + "\n");
  const env = { ...process.env, SB_URL, MCP_CREDENTIALS_FILE: join(dir, "credentials"), MCP_ACCESS_LIST_FILE: join(dir, "access-list"), MCP_ALLOWLIST_FILE: join(dir, "allowlist"), MCP_ALLOWED_FILES_FILE: join(dir, "none") };
  const run = (extra: Record<string, string>) => {
    const r = spawnSync(process.execPath, [join(ROOT, "src/main.ts"), "--scan"], { env: { ...env, ...extra }, stdio: ["ignore", "pipe", "pipe"] });
    return { code: r.status, err: r.stderr.toString() };
  };
  const planted = unique("Quarantine me");
  const source = 'Text ${1 + 1}\n\n```space-lua\nfunction q() end\n```\n\nLeak: ${space.readPage("CONFIG")} and a `tick`.\n';
  await sb.write(T.admin, "beta", `${planted}.md`, source);
  try {
    const report = run({ MCP_SPACES: "alpha,beta" });
    assert.equal(report.code, 1);
    assert.match(report.err, /- alpha: guarded, transform present, \d+ finding\(s\), 1 non-page file\(s\)/);
    assert.match(report.err, /- beta: guarded, transform present, 2 finding\(s\)/);
    assert.match(report.err, new RegExp(`${planted}:3 fence`));

    // Limited to beta: alpha's seed pages hold code on purpose and must stay as they are.
    const q = run({ MCP_SCAN_MODE: "quarantine", MCP_SPACES: "beta" });
    assert.equal(q.code, 0, q.err);
    assert.match(q.err, /^Scan of 1 space\(s\)/);
    assert.match(q.err, /- beta: guarded, transform present, 0 finding\(s\)/);
    const after = (await sb.read(T.admin, "beta", `${planted}.md`)).text;
    assert.equal(after, 'Text ${1 + 1}\n\n```lua\nfunction q() end\n```\n\nLeak: `${space.readPage("CONFIG")}` and a `tick`.\n\n#quarantined\n');
  } finally {
    await sb.remove(T.admin, "beta", `${planted}.md`);
    rmSync(dir, { recursive: true, force: true });
  }
});
