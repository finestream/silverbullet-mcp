// Cloudflare Access in front of the server (docs/cloudflare-access.md) against
// the compose test instance and a test team domain: a local HTTP server that
// publishes signing keys where a team domain does and signs assertions the way
// Access does. The tests send the `Cf-Access-Jwt-Assertion` header themselves;
// no Cloudflare account is needed to run this.

import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey } from "jose";
import { extractWWWAuthenticateParams } from "@modelcontextprotocol/sdk/client/auth.js";
import { startServer, connect, credentialsFile, BEARERS, unique, type RunningServer } from "./harness.ts";
import { sb, T } from "../lib/env.ts";

const AUD = "4714c1358e65fe4b408ad6d432a5f878f08194bdb4752441fd56faefa9b2b6f2";
/** The OAuth resource of the server that has both ways in; only an identifier here. */
const RESOURCE = "http://localhost:4000/mcp";
const HEADER = "Cf-Access-Jwt-Assertion";

/** alice and bob have an address, carol has none; the scan's line has one, which must select nobody. */
const CREDENTIALS = () => credentialsFile({ emails: { alice: "alice@example.org,a.liddell@example.org", bob: "bob@example.org", scan: "scan@example.org" } });

let teamServer: Server;
let TEAM: string;
let key: CryptoKey;
let foreignKey: CryptoKey;
let server: RunningServer;
let certRequests = 0;
const created: string[] = [];

const now = () => Math.floor(Date.now() / 1000);

/** An assertion as the test team domain signs it for a user; `claims` override, `undefined` removes. */
const assertion = (claims: Record<string, unknown> = {}, signWith: CryptoKey = key) =>
  new SignJWT({ aud: [AUD], email: "alice@example.org", exp: now() + 300, iat: now(), nbf: now(), iss: TEAM, type: "app", identity_nonce: "n0nce", sub: "7335d417-61da-459d-899c-0a01c76a2f94", country: "CH", ...claims })
    .setProtectedHeader({ alg: "RS256", kid: "access-1", typ: "JWT" })
    .sign(signWith);

const INITIALIZE = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "access-test", version: "0" } } });

/** One raw request to /mcp with the given headers, to see the status and the challenge. */
const post = (url: string, headers: Record<string, string> = {}) =>
  fetch(`${url}/mcp`, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers }, body: INITIALIZE });

before(async () => {
  const pair = await generateKeyPair("RS256");
  key = pair.privateKey;
  foreignKey = (await generateKeyPair("RS256")).privateKey;
  const jwk = { ...(await exportJWK(pair.publicKey)), kid: "access-1", alg: "RS256", use: "sig" };
  teamServer = createServer((req, res) => {
    if (req.url === "/cdn-cgi/access/certs") {
      certRequests++;
      res.writeHead(200, { "Content-Type": "application/json" });
      // The shape of a team domain's answer: the key set, and the same keys as certificates, which the server does not use.
      return res.end(JSON.stringify({ keys: [jwk], public_cert: { kid: "access-1", cert: "-----BEGIN CERTIFICATE-----" }, public_certs: [{ kid: "access-1", cert: "-----BEGIN CERTIFICATE-----" }] }));
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => teamServer.listen(0, "127.0.0.1", resolve));
  TEAM = `http://127.0.0.1:${(teamServer.address() as AddressInfo).port}`;
  server = await startServer({ credentials: CREDENTIALS(), env: { MCP_CF_ACCESS_TEAM_DOMAIN: TEAM, MCP_CF_ACCESS_AUD: AUD } });
});

after(async () => {
  await server?.stop();
  await new Promise((resolve) => teamServer?.close(resolve));
  for (const f of created) await sb.remove(T.admin, "alpha", f);
});

test("valid assertion: an assertion for A's address acts as A, with A's line in the credentials file and A's entries in the access list", async () => {
  const alice = await connect(server.url, { [HEADER]: await assertion() });
  const bob = await connect(server.url, { [HEADER]: await assertion({ email: "bob@example.org" }) });
  try {
    const spaces = await alice.call("list-spaces");
    assert.equal(spaces.isError, false, spaces.text);
    assert.deepEqual((spaces.data!.spaces as Array<{ space: string }>).map((s) => s.space), ["alpha", "gamma"], "alice's spaces, through alice's SilverBullet token");
    const denied = await alice.call("read-note", { filename: "CONFIG" });
    assert.match(denied.text, /^Denied by the access list: user "alice" has no "r" on alpha\/CONFIG/);
    // alice's own area in alpha: alice may write there, bob may not.
    const name = unique("Agent/Access");
    created.push(`${name}.md`);
    const written = await alice.call("create-note", { filename: name, content: "written through Cloudflare Access\n" });
    assert.equal(written.isError, false, written.text);
    const refused = await bob.call("create-note", { space: "alpha", filename: unique("Agent/Access bob"), content: "x\n" });
    assert.match(refused.text, /^Denied by the access list: user "bob" has no "w" on alpha\/Agent\//);
    assert.ok((await bob.call("list-spaces")).data!.spaces.some((s: { space: string }) => s.space === "beta"), "bob's spaces");
    assert.ok(server.logs.some((l) => l.includes('"tool":"create-note"') && l.includes('"user":"alice"')), "the request log names the user");
  } finally {
    await alice.close();
    await bob.close();
  }
});

test("user mapping: a second address of the same line and an address in another case select the user", async () => {
  for (const email of ["a.liddell@example.org", "Alice@Example.ORG"]) {
    const client = await connect(server.url, { [HEADER]: await assertion({ email }) });
    try {
      assert.match((await client.call("read-note", { filename: "CONFIG" })).text, /user "alice"/, email);
    } finally {
      await client.close();
    }
  }
  assert.equal(certRequests, 1, "the team domain's keys were read once");
});

test("rejected: wrong audience, wrong issuer, expired, unsigned, another key, an unknown address, a service token and the scan's technical user all get 401, and no pointer to an authorization server", async () => {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const unsigned = `${b64({ alg: "none", typ: "JWT" })}.${b64({ aud: [AUD], email: "alice@example.org", exp: now() + 300, iss: TEAM })}.`;
  const cases: Array<[string, string, RegExp]> = [
    ["wrong audience: another application of the team", await assertion({ aud: ["f".repeat(64)] }), /claim \\"aud\\"/],
    ["wrong issuer: another team", await assertion({ iss: "http://127.0.0.1:1" }), /claim \\"iss\\"/],
    ["expired", await assertion({ exp: now() - 120 }), /Access assertion: expired/],
    ["unsigned", unsigned, /Access assertion/],
    ["signed by another key", await assertion({}, foreignKey), /signature/i],
    ["an address without a line", await assertion({ email: "mallory@example.org" }), /no line of the credentials file has the e-mail address \\"mallory@example.org\\"/],
    ["a user name instead of an address", await assertion({ email: "alice" }), /no line of the credentials file/],
    ["a service token: no e-mail address", await assertion({ email: undefined, sub: "", common_name: "0123456789abcdef.access" }), /no \\"email\\" claim/],
    ["the scan's technical user", await assertion({ email: "scan@example.org" }), /no line of the credentials file has the e-mail address \\"scan@example.org\\"/],
  ];
  for (const [name, a, reason] of cases) {
    const before = server.logs.length;
    const res = await post(server.url, { [HEADER]: a });
    assert.equal(res.status, 401, name);
    assert.equal(res.headers.get("www-authenticate"), 'Bearer realm="silverbullet-mcp", error="invalid_token"', name);
    assert.doesNotMatch(await res.text(), /aud|iss|expired|mallory|credentials/, `${name}: the reason is logged, not sent`);
    const line = server.logs.slice(before).find((l) => l.includes("auth.refused"));
    assert.match(line ?? "", reason, `${name}: the log says why`);
    assert.ok(!(line ?? "").includes(a), `${name}: the assertion is not logged`);
  }
});

test("the assertion decides alone: a refused assertion is not rescued by a valid bearer on the same request", async () => {
  const res = await post(server.url, { [HEADER]: await assertion({ email: "mallory@example.org" }), Authorization: `Bearer ${BEARERS.alice}` });
  assert.equal(res.status, 401);
  // And the other way round: Access forwards whatever Authorization header the client sent; it is not looked at.
  const client = await connect(server.url, { [HEADER]: await assertion({ email: "bob@example.org" }), Authorization: "Bearer an-opaque-token-of-access" });
  try {
    assert.match((await client.call("read-note", { space: "alpha", filename: "CONFIG" })).text, /user "bob"/);
  } finally {
    await client.close();
  }
});

test("static bearers are unchanged beside it: a request without an assertion is authenticated as before, and challenged as before", async () => {
  const stat = await connect(server.url, BEARERS.carol);
  try {
    assert.equal((await stat.call("list-spaces")).isError, false, "carol has no address and still her bearer");
  } finally {
    await stat.close();
  }
  const none = await post(server.url);
  assert.equal(none.status, 401);
  assert.equal(none.headers.get("www-authenticate"), 'Bearer realm="silverbullet-mcp"');
  const unknown = await post(server.url, { Authorization: "Bearer not-a-bearer" });
  assert.equal(unknown.status, 401);
  assert.equal((await fetch(`${server.url}/.well-known/oauth-protected-resource`)).status, 404, "no OAuth issuer is configured, so there is no metadata");
});

test("beside OAuth: tokens and their challenge are unchanged; a request through Access is never pointed at the OAuth issuer", async () => {
  // An OAuth issuer that is never reached: what matters here is which challenge and which metadata a request gets.
  const both = await startServer({ credentials: CREDENTIALS(), env: { MCP_CF_ACCESS_TEAM_DOMAIN: TEAM, MCP_CF_ACCESS_AUD: AUD, MCP_OAUTH_ISSUER: "http://127.0.0.1:1/realms/none", MCP_OAUTH_RESOURCE: RESOURCE } });
  try {
    const metadata = "http://localhost:4000/.well-known/oauth-protected-resource/mcp";
    const none = await post(both.url);
    assert.equal(none.status, 401);
    assert.equal(extractWWWAuthenticateParams(none).resourceMetadataUrl?.href, metadata, "without an assertion: the OAuth challenge, as before");
    const badToken = await post(both.url, { Authorization: "Bearer not-a-token" });
    assert.equal(extractWWWAuthenticateParams(badToken).resourceMetadataUrl?.href, metadata);
    assert.equal((await fetch(`${both.url}/.well-known/oauth-protected-resource/mcp`)).status, 200);

    const refused = await post(both.url, { [HEADER]: await assertion({ email: "mallory@example.org" }) });
    assert.equal(refused.status, 401);
    assert.equal(refused.headers.get("www-authenticate"), 'Bearer realm="silverbullet-mcp", error="invalid_token"', "with an assertion: no resource_metadata");
    for (const path of ["/.well-known/oauth-protected-resource/mcp", "/.well-known/oauth-protected-resource"]) {
      assert.equal((await fetch(both.url + path, { headers: { [HEADER]: await assertion() } })).status, 404, `${path} through Access`);
    }

    const access = await connect(both.url, { [HEADER]: await assertion() });
    const stat = await connect(both.url, BEARERS.bob);
    try {
      assert.match((await access.call("read-note", { filename: "CONFIG" })).text, /user "alice"/);
      assert.equal((await stat.call("list-spaces")).isError, false);
    } finally {
      await access.close();
      await stat.close();
    }
  } finally {
    await both.stop();
  }
});

test("without the Access settings nothing changes: the header is not looked at", async () => {
  const plain = await startServer({ credentials: CREDENTIALS() });
  try {
    const res = await post(plain.url, { [HEADER]: await assertion() });
    assert.equal(res.status, 401, "a valid assertion alone is no way in");
    assert.equal(res.headers.get("www-authenticate"), 'Bearer realm="silverbullet-mcp"');
    assert.ok(plain.logs.some((l) => l.includes("auth.refused") && l.includes("no bearer")));
    const stat = await connect(plain.url, { [HEADER]: "garbage", Authorization: `Bearer ${BEARERS.alice}` });
    try {
      assert.equal((await stat.call("list-spaces")).isError, false, "a bearer works whatever the header holds");
    } finally {
      await stat.close();
    }
  } finally {
    await plain.stop();
  }
});

test("team domain unreachable: the server starts and serves static bearers; assertions are refused with 401, not an error", async () => {
  const lonely = await startServer({ credentials: CREDENTIALS(), env: { MCP_CF_ACCESS_TEAM_DOMAIN: "http://127.0.0.1:1", MCP_CF_ACCESS_AUD: AUD } });
  try {
    const stat = await connect(lonely.url, BEARERS.alice);
    assert.equal((await stat.call("list-spaces")).isError, false);
    await stat.close();
    const res = await post(lonely.url, { [HEADER]: await assertion() });
    assert.equal(res.status, 401);
    assert.ok(lonely.logs.some((l) => l.includes("auth.refused") && l.includes("Access assertion")), lonely.logs.slice(-3).join("\n"));
  } finally {
    await lonely.stop();
  }
});

test("configuration: only one of the two settings, a team domain with a path, or an address on two lines of the credentials file", async () => {
  await assert.rejects(startServer({ env: { MCP_CF_ACCESS_TEAM_DOMAIN: TEAM } }), /needs both MCP_CF_ACCESS_TEAM_DOMAIN and MCP_CF_ACCESS_AUD/);
  await assert.rejects(startServer({ env: { MCP_CF_ACCESS_TEAM_DOMAIN: `${TEAM}/cdn-cgi/access/certs`, MCP_CF_ACCESS_AUD: AUD } }), /the team domain alone/);
  // A credentials file with a problem is not used at all: nobody is authenticated until it is corrected (as for any other problem in it).
  const twice = await startServer({ credentials: credentialsFile({ emails: { alice: "shared@example.org", bob: "shared@example.org" } }), env: { MCP_CF_ACCESS_TEAM_DOMAIN: TEAM, MCP_CF_ACCESS_AUD: AUD } });
  try {
    assert.ok(twice.logs.some((l) => l.includes("config.problems") && l.includes("e-mail address already used by")), "the problem is logged");
    assert.equal((await post(twice.url, { [HEADER]: await assertion({ email: "shared@example.org" }) })).status, 401);
    assert.equal((await fetch(`${twice.url}/healthz`)).status, 503);
  } finally {
    await twice.stop();
  }
});
