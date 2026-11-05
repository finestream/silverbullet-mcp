// OAuth 2.1 resource server (docs/oauth.md; docs/architecture.md, section 2)
// against the compose test instance and a test issuer: a local HTTP server
// that publishes OpenID Connect discovery and a JWKS, and signs tokens the way
// an identity provider does. No identity provider is needed to run this.

import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey } from "jose";
import { discoverOAuthProtectedResourceMetadata, extractWWWAuthenticateParams } from "@modelcontextprotocol/sdk/client/auth.js";
import { OAuthProtectedResourceMetadataSchema } from "@modelcontextprotocol/sdk/shared/auth.js";
import { startServer, connect, BEARERS, unique, type RunningServer } from "./harness.ts";
import { sb, T } from "../lib/env.ts";

/** What tokens must name as their audience; only an identifier here, the tests reach the server by its port. */
const RESOURCE = "http://localhost:4000/mcp";

let issuerServer: Server;
let ISSUER: string;
let key: CryptoKey;
let foreignKey: CryptoKey;
let server: RunningServer;
let discoveryRequests = 0;
const created: string[] = [];

const now = () => Math.floor(Date.now() / 1000);

/** A token as the test issuer signs it; `claims` override, `undefined` removes. */
const token = (claims: Record<string, unknown> = {}, signWith: CryptoKey = key) =>
  new SignJWT({ iss: ISSUER, aud: RESOURCE, exp: now() + 300, iat: now(), preferred_username: "alice", scope: "openid", typ: "Bearer", ...claims })
    .setProtectedHeader({ alg: "RS256", kid: "test-1", typ: "JWT" })
    .sign(signWith);

const INITIALIZE = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "oauth-test", version: "0" } } });

/** One raw request to /mcp, to see the status and the challenge. */
const post = (url: string, bearer?: string) =>
  fetch(`${url}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) },
    body: INITIALIZE,
  });

before(async () => {
  const pair = await generateKeyPair("RS256");
  key = pair.privateKey;
  foreignKey = (await generateKeyPair("RS256")).privateKey;
  const jwk = { ...(await exportJWK(pair.publicKey)), kid: "test-1", alg: "RS256", use: "sig" };
  issuerServer = createServer((req, res) => {
    const send = (body: unknown) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.url === "/realms/test/.well-known/openid-configuration") {
      discoveryRequests++;
      return send({ issuer: ISSUER, jwks_uri: `${ISSUER}/certs`, authorization_endpoint: `${ISSUER}/auth`, token_endpoint: `${ISSUER}/token`, response_types_supported: ["code"] });
    }
    if (req.url === "/realms/test/certs") return send({ keys: [jwk] });
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => issuerServer.listen(0, "127.0.0.1", resolve));
  ISSUER = `http://127.0.0.1:${(issuerServer.address() as AddressInfo).port}/realms/test`;
  server = await startServer({ env: { MCP_OAUTH_ISSUER: ISSUER, MCP_OAUTH_RESOURCE: RESOURCE } });
});

after(async () => {
  await server?.stop();
  await new Promise((resolve) => issuerServer?.close(resolve));
  for (const f of created) await sb.remove(T.admin, "alpha", f);
});

test("metadata: the Protected Resource Metadata is served at both well-known paths, is valid for the MCP SDK's client, and names the resource and the issuer", async () => {
  for (const path of ["/.well-known/oauth-protected-resource/mcp", "/.well-known/oauth-protected-resource"]) {
    const res = await fetch(server.url + path);
    assert.equal(res.status, 200, path);
    assert.match(res.headers.get("content-type") ?? "", /^application\/json/);
    const meta = OAuthProtectedResourceMetadataSchema.parse(await res.json());
    assert.equal(meta.resource, RESOURCE);
    assert.deepEqual(meta.authorization_servers, [ISSUER]);
    assert.deepEqual(meta.bearer_methods_supported, ["header"]);
  }
  // The discovery an MCP client runs, with the SDK's own code.
  const discovered = await discoverOAuthProtectedResourceMetadata(`${server.url}/mcp`);
  assert.equal(discovered.resource, RESOURCE);
  assert.equal((await fetch(`${server.url}/.well-known/oauth-protected-resource`, { method: "POST" })).status, 405);
});

test("challenge: a request without a bearer gets 401 and a WWW-Authenticate that names the metadata; a bad token adds error=invalid_token", async () => {
  const none = await post(server.url);
  assert.equal(none.status, 401);
  assert.equal(none.headers.get("www-authenticate"), 'Bearer realm="silverbullet-mcp", resource_metadata="http://localhost:4000/.well-known/oauth-protected-resource/mcp"');
  assert.equal(extractWWWAuthenticateParams(none).resourceMetadataUrl?.href, "http://localhost:4000/.well-known/oauth-protected-resource/mcp", "the SDK's client reads the metadata URL from the challenge");
  const bad = await post(server.url, await token({ aud: "https://other.example.org/mcp" }));
  assert.equal(bad.status, 401);
  assert.equal(extractWWWAuthenticateParams(bad).error, "invalid_token");
  assert.doesNotMatch(await bad.text(), /aud|audience/, "the reason is logged, not sent");
});

test("valid token: user A's token acts as A, with A's line in the credentials file and A's entries in the access list", async () => {
  const alice = await connect(server.url, await token({ preferred_username: "alice" }));
  const bob = await connect(server.url, await token({ preferred_username: "bob" }));
  try {
    const spaces = await alice.call("list-spaces");
    assert.equal(spaces.isError, false, spaces.text);
    assert.deepEqual((spaces.data!.spaces as Array<{ space: string }>).map((s) => s.space), ["alpha", "gamma"], "alice's spaces, through alice's SilverBullet token");
    const denied = await alice.call("read-note", { filename: "CONFIG" });
    assert.match(denied.text, /^Denied by the access list: user "alice" has no "r" on alpha\/CONFIG/);
    // alice's own area in alpha: alice may write there, bob may not.
    const name = unique("Agent/OAuth");
    created.push(`${name}.md`);
    const written = await alice.call("create-note", { filename: name, content: "written with an access token\n" });
    assert.equal(written.isError, false, written.text);
    const refused = await bob.call("create-note", { space: "alpha", filename: unique("Agent/OAuth bob"), content: "x\n" });
    assert.match(refused.text, /^Denied by the access list: user "bob" has no "w" on alpha\/Agent\//);
    const bobSpaces = await bob.call("list-spaces");
    assert.ok((bobSpaces.data!.spaces as Array<{ space: string }>).some((s) => s.space === "beta"), "bob's spaces");
    assert.ok(server.logs.some((l) => l.includes('"tool":"create-note"') && l.includes('"user":"alice"')), "the request log names the user");
  } finally {
    await alice.close();
    await bob.close();
  }
});

test("rejected: wrong audience, expired, wrong issuer, another key, an unknown user and the scan's technical user all get 401", async () => {
  const cases: Array<[string, string, RegExp]> = [
    ["wrong audience", await token({ aud: "https://other.example.org/mcp" }), /claim \\"aud\\"/],
    ["the client as audience", await token({ aud: "some-client" }), /claim \\"aud\\"/],
    ["expired", await token({ exp: now() - 120 }), /expired/],
    ["wrong issuer", await token({ iss: "http://127.0.0.1:1/realms/other" }), /claim \\"iss\\"/],
    ["signed by another key", await token({}, foreignKey), /signature/i],
    ["unknown preferred_username", await token({ preferred_username: "mallory" }), /mallory\\" has no line in the credentials file/],
    ["no preferred_username", await token({ preferred_username: undefined }), /no \\"preferred_username\\" claim/],
    ["the scan's technical user", await token({ preferred_username: "scan" }), /scan\\" has no line in the credentials file/],
  ];
  for (const [name, t, reason] of cases) {
    const before = server.logs.length;
    const res = await post(server.url, t);
    assert.equal(res.status, 401, name);
    assert.equal(extractWWWAuthenticateParams(res).error, "invalid_token", name);
    const line = server.logs.slice(before).find((l) => l.includes("auth.refused"));
    assert.match(line ?? "", reason, `${name}: the log says why`);
    assert.ok(!(line ?? "").includes(t), `${name}: the token is not logged`);
  }
});

test("user mapping: a user name in another case selects the only line that matches; static bearers keep working beside OAuth", async () => {
  const folded = await connect(server.url, await token({ preferred_username: "Alice" }));
  const stat = await connect(server.url, BEARERS.alice);
  try {
    assert.match((await folded.call("read-note", { filename: "CONFIG" })).text, /user "alice"/);
    assert.equal((await stat.call("list-spaces")).isError, false);
  } finally {
    await folded.close();
    await stat.close();
  }
  assert.equal(discoveryRequests, 1, "the issuer's metadata was read once");
});

test("scopes: with MCP_OAUTH_SCOPES a token without the scope gets 403 insufficient_scope, and the metadata and the challenge name the scope", async () => {
  const scoped = await startServer({ env: { MCP_OAUTH_ISSUER: ISSUER, MCP_OAUTH_RESOURCE: RESOURCE, MCP_OAUTH_SCOPES: "mcp:tools" } });
  try {
    const meta = (await (await fetch(`${scoped.url}/.well-known/oauth-protected-resource/mcp`)).json()) as { scopes_supported?: string[] };
    assert.deepEqual(meta.scopes_supported, ["mcp:tools"]);
    const without = await post(scoped.url, await token());
    assert.equal(without.status, 403);
    const params = extractWWWAuthenticateParams(without);
    assert.equal(params.error, "insufficient_scope");
    assert.equal(params.scope, "mcp:tools");
    const client = await connect(scoped.url, await token({ scope: "openid mcp:tools" }));
    assert.equal((await client.call("list-spaces")).isError, false);
    await client.close();
  } finally {
    await scoped.stop();
  }
});

test("without OAuth settings nothing changes: no metadata, the plain challenge, tokens are just unknown bearers", async () => {
  const plain = await startServer();
  try {
    assert.equal((await fetch(`${plain.url}/.well-known/oauth-protected-resource`)).status, 404);
    const res = await post(plain.url, await token());
    assert.equal(res.status, 401);
    assert.equal(res.headers.get("www-authenticate"), 'Bearer realm="silverbullet-mcp"');
  } finally {
    await plain.stop();
  }
});

test("issuer unreachable: the server starts and serves static bearers; tokens are refused with 401, not an error", async () => {
  const lonely = await startServer({ env: { MCP_OAUTH_ISSUER: "http://127.0.0.1:1/realms/none", MCP_OAUTH_RESOURCE: RESOURCE } });
  try {
    const stat = await connect(lonely.url, BEARERS.alice);
    assert.equal((await stat.call("list-spaces")).isError, false);
    await stat.close();
    const res = await post(lonely.url, await token());
    assert.equal(res.status, 401);
    assert.ok(lonely.logs.some((l) => l.includes("auth.refused") && l.includes("the issuer's metadata is not available")), lonely.logs.slice(-3).join("\n"));
  } finally {
    await lonely.stop();
  }
});

test("configuration: OAuth with only one of the two settings, or an http issuer that is not local, stops the server at start", async () => {
  await assert.rejects(startServer({ env: { MCP_OAUTH_ISSUER: ISSUER } }), /needs both MCP_OAUTH_ISSUER and MCP_OAUTH_RESOURCE/);
  await assert.rejects(startServer({ env: { MCP_OAUTH_ISSUER: "http://login.example.org/realms/main", MCP_OAUTH_RESOURCE: RESOURCE } }), /must be an https URL/);
});
