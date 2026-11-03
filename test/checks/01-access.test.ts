// Access and identity: what the architecture relies on for authentication,
// space discovery and conditional writes (docs/architecture.md, "Access and
// identity"; docs/security.md, section 3).

import test from "node:test";
import assert from "node:assert/strict";
import { sb, T, S } from "../lib/env.ts";

test("access: a user's API token works on every space the user may reach", async () => {
  assert.equal((await sb.read(T.alice, S.alpha, "Rendered.md")).status, 200);
  assert.equal((await sb.read(T.bob, S.alpha, "Rendered.md")).status, 200, "a read member reads");
  assert.equal((await sb.read(T.bob, S.beta, "Secret.md")).status, 200);
});

test("access: refusals are clear status codes: 403 without access, 404 unknown space, 401 missing or wrong token", async () => {
  const noAccess = await sb.read(T.alice, S.beta, "Secret.md");
  assert.equal(noAccess.status, 403, noAccess.text);
  assert.equal((await sb.read(T.alice, "nosuchspace", "index.md")).status, 404);
  assert.equal((await sb.read(undefined, S.alpha, "Rendered.md")).status, 401);
  assert.equal((await sb.read("not-a-token", S.alpha, "Rendered.md")).status, 401);
});

test("access: a read-only member gets 403 on PUT; /.config tells read from write (readOnly)", async () => {
  assert.equal((await sb.write(T.bob, S.alpha, "Bob wrote this.md", "x")).status, 403);
  const alice = await sb.config(T.alice, S.alpha);
  const bob = await sb.config(T.bob, S.alpha);
  assert.equal(alice.status, 200);
  assert.equal(alice.json?.readOnly, false);
  assert.equal(bob.json?.readOnly, true);
});

test("access: /.config lists every space prefix of the instance and refuses a non-member", async () => {
  const { json } = await sb.config(T.alice, S.alpha);
  const prefixes = json?.spacePrefixes as string[];
  assert.ok(Array.isArray(prefixes), "spacePrefixes is an array");
  assert.ok(prefixes.includes("/alpha") && prefixes.includes("/beta"), JSON.stringify(prefixes));
  assert.equal((await sb.config(T.alice, S.beta)).status, 403);
});

test("[watch] access: /.dashboard/api/spaces accepts no API token (the user's space list needs a session cookie)", async () => {
  const r = await sb.admin.api({ token: T.alice }, "GET", "/spaces");
  assert.equal(r.status, 401, `now ${r.status}: space discovery could use this endpoint instead of probing /.config`);
});

test("access: conditional writes: stale If-Match is 412, If-None-Match * on an existing file is 412, ETags are strong sha256", async () => {
  const page = "Conditional.md";
  const created = await sb.write(T.alice, S.alpha, page, "first");
  assert.ok([200, 201, 204].includes(created.status), `create: ${created.status}`);
  const read = await sb.read(T.alice, S.alpha, page);
  assert.match(read.etag ?? "", /^"sha256:[0-9a-f]+"$/, `etag ${read.etag}`);
  assert.equal((await sb.write(T.alice, S.alpha, page, "second", { "If-Match": '"sha256:stale"' })).status, 412);
  assert.equal((await sb.write(T.alice, S.alpha, page, "third", { "If-None-Match": "*" })).status, 412);
  assert.ok([200, 201, 204].includes((await sb.write(T.alice, S.alpha, page, "fourth", { "If-Match": read.etag! })).status), "a fresh If-Match writes");
  await sb.remove(T.alice, S.alpha, page);
});

test("access: the admin API accepts an administrator's API token as bearer", async () => {
  assert.equal((await sb.admin.api({ token: T.admin }, "GET", "/admin/spaces")).status, 200);
  const plain = (await sb.admin.api({ token: T.alice }, "GET", "/admin/spaces")).status;
  assert.ok([401, 403].includes(plain), `a plain user's token is refused (${plain})`);
});
