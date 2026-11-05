import test from "node:test";
import assert from "node:assert/strict";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type CryptoKey, type JWK } from "jose";
import { loadOAuthConfig, metadataUrls, OAuthVerifier, type OAuthConfig } from "./oauth.ts";
import { parseCredentials } from "./credentials.ts";
import { userOfClaim } from "./server.ts";

const ISSUER = "https://login.example.org/realms/main";
const RESOURCE = "https://mcp.example.org/mcp";
const CONFIG: OAuthConfig = { issuer: ISSUER, resource: RESOURCE, jwksUrl: null, userClaim: "preferred_username", scopes: [] };

const { publicKey, privateKey } = await generateKeyPair("RS256");
const other = await generateKeyPair("RS256");
const jwk: JWK = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256", use: "sig" };
const keys = createLocalJWKSet({ keys: [jwk] });
const verifier = new OAuthVerifier(CONFIG, keys);

type Claims = Record<string, unknown>;
const now = () => Math.floor(Date.now() / 1000);
const token = (claims: Claims = {}, opts: { key?: CryptoKey; kid?: string; exp?: number | null } = {}) => {
  const jwt = new SignJWT({ preferred_username: "alice", scope: "openid", ...claims })
    .setProtectedHeader({ alg: "RS256", kid: opts.kid ?? "k1" })
    .setIssuedAt();
  if (!("iss" in claims)) jwt.setIssuer(ISSUER);
  if (!("aud" in claims)) jwt.setAudience(RESOURCE);
  if (opts.exp !== null) jwt.setExpirationTime(opts.exp ?? now() + 300);
  return jwt.sign(opts.key ?? privateKey);
};

test("oauth: a token of the issuer for this resource, not expired, names its user", async () => {
  const r = await verifier.verify(await token());
  assert.equal(r.ok, true);
  assert.equal(r.ok && r.username, "alice");
  const several = await verifier.verify(await token({ aud: ["account", RESOURCE] }));
  assert.equal(several.ok, true, "the resource is one of several audiences");
});

test("oauth: wrong audience, wrong issuer, expired, not yet valid, and no expiry are rejected as invalid_token", async () => {
  const cases: Array<[string, Promise<string>, RegExp]> = [
    ["another audience", token({ aud: "https://other.example.org/mcp" }), /claim "aud"/],
    ["the client as audience, as an ID token has it", token({ aud: "claude" }), /claim "aud"/],
    ["the resource without its path", token({ aud: "https://mcp.example.org" }), /claim "aud"/],
    ["no audience", token({ aud: undefined }), /claim "aud"/],
    ["another issuer", token({ iss: "https://login.example.org/realms/other" }), /claim "iss"/],
    ["expired", token({}, { exp: now() - 120 }), /expired/],
    ["not yet valid", token({ nbf: now() + 600 }), /claim "nbf"/],
    ["no expiry", token({}, { exp: null }), /claim "exp"/],
  ];
  for (const [name, t, reason] of cases) {
    const r = await verifier.verify(await t);
    assert.equal(r.ok, false, name);
    assert.equal(!r.ok && r.error, "invalid_token", name);
    assert.match(!r.ok ? r.reason : "", reason, name);
  }
});

test("oauth: a signature by another key, an unsigned token, an HMAC token keyed with the public key, and garbage are rejected", async () => {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const payload = { iss: ISSUER, aud: RESOURCE, exp: now() + 300, preferred_username: "alice" };
  const hmacKey = new TextEncoder().encode(JSON.stringify(jwk));
  const cases: Array<[string, string]> = [
    ["another key, same kid", await token({}, { key: other.privateKey })],
    ["an unknown kid", await token({}, { kid: "k2" })],
    ["alg none", `${b64({ alg: "none", typ: "JWT" })}.${b64(payload)}.`],
    ["HS256 with the public key as the secret", await new SignJWT(payload).setProtectedHeader({ alg: "HS256", kid: "k1" }).sign(hmacKey)],
    ["not a token", "alice-client-secret"],
    ["empty parts", ".."],
  ];
  for (const [name, t] of cases) {
    const r = await verifier.verify(t);
    assert.equal(r.ok, false, name);
    assert.equal(!r.ok && r.error, "invalid_token", name);
  }
});

test("oauth: the user claim must be a non-empty string; another claim can be configured", async () => {
  for (const value of [undefined, "", 7, ["alice"]]) {
    const r = await verifier.verify(await token({ preferred_username: value }));
    assert.equal(r.ok, false, JSON.stringify(value));
  }
  const byAttribute = new OAuthVerifier({ ...CONFIG, userClaim: "sb_user" }, keys);
  const r = await byAttribute.verify(await token({ sb_user: "writer-bot" }));
  assert.equal(r.ok && r.username, "writer-bot");
});

test("oauth: required scopes must all be in the token; a missing one is insufficient_scope", async () => {
  const scoped = new OAuthVerifier({ ...CONFIG, scopes: ["mcp:tools"] }, keys);
  assert.equal((await scoped.verify(await token({ scope: "openid mcp:tools" }))).ok, true);
  const r = await scoped.verify(await token({ scope: "openid mcp:toolsX" }));
  assert.equal(!r.ok && r.error, "insufficient_scope");
  assert.equal(!(await scoped.verify(await token({ scope: undefined }))).ok, true);
});

test("oauth: the metadata names the resource and the issuer; the challenge names the metadata", () => {
  assert.deepEqual(verifier.metadata(), { resource: RESOURCE, authorization_servers: [ISSUER], bearer_methods_supported: ["header"], resource_name: "silverbullet-mcp" });
  assert.deepEqual(verifier.metadataPaths(), ["/.well-known/oauth-protected-resource/mcp", "/.well-known/oauth-protected-resource"]);
  assert.equal(verifier.challenge(), 'Bearer realm="silverbullet-mcp", resource_metadata="https://mcp.example.org/.well-known/oauth-protected-resource/mcp"');
  const scoped = new OAuthVerifier({ ...CONFIG, scopes: ["mcp:tools"] }, keys);
  assert.deepEqual(scoped.metadata().scopes_supported, ["mcp:tools"]);
  assert.equal(scoped.challenge("invalid_token"), 'Bearer realm="silverbullet-mcp", resource_metadata="https://mcp.example.org/.well-known/oauth-protected-resource/mcp", scope="mcp:tools", error="invalid_token"');
  const atRoot = new OAuthVerifier({ ...CONFIG, resource: "https://mcp.example.org" }, keys);
  assert.deepEqual(atRoot.metadataPaths(), ["/.well-known/oauth-protected-resource"]);
});

test("oauth: the issuer's metadata is looked for where MCP clients look", () => {
  assert.deepEqual(metadataUrls(ISSUER), [
    "https://login.example.org/.well-known/oauth-authorization-server/realms/main",
    "https://login.example.org/.well-known/openid-configuration/realms/main",
    "https://login.example.org/realms/main/.well-known/openid-configuration",
  ]);
  assert.deepEqual(metadataUrls("https://login.example.org"), ["https://login.example.org/.well-known/oauth-authorization-server", "https://login.example.org/.well-known/openid-configuration"]);
});

test("oauth: configuration: off without the variables; both are needed; https except on a loopback address", () => {
  assert.equal(loadOAuthConfig({}), null);
  assert.throws(() => loadOAuthConfig({ MCP_OAUTH_ISSUER: ISSUER }), /needs both/);
  assert.throws(() => loadOAuthConfig({ MCP_OAUTH_ISSUER: "http://login.example.org/realms/main", MCP_OAUTH_RESOURCE: RESOURCE }), /must be an https URL/);
  assert.throws(() => loadOAuthConfig({ MCP_OAUTH_ISSUER: ISSUER, MCP_OAUTH_RESOURCE: "mcp.example.org/mcp" }), /not a URL/);
  assert.throws(() => loadOAuthConfig({ MCP_OAUTH_ISSUER: ISSUER, MCP_OAUTH_RESOURCE: RESOURCE + "#x" }), /no fragment/);
  assert.deepEqual(loadOAuthConfig({ MCP_OAUTH_ISSUER: ISSUER, MCP_OAUTH_RESOURCE: RESOURCE, MCP_OAUTH_SCOPES: "mcp:tools, offline_access" }), { ...CONFIG, scopes: ["mcp:tools", "offline_access"] });
  assert.equal(loadOAuthConfig({ MCP_OAUTH_ISSUER: "http://127.0.0.1:8080/realms/test", MCP_OAUTH_RESOURCE: "http://localhost:4000/mcp" })?.issuer, "http://127.0.0.1:8080/realms/test");
});

test("oauth: the user claim selects a line of the credentials file: exactly, or the only line in another case; never the scan user", () => {
  const { credentials } = parseCredentials("Writer tok1 notes agents -\nreader tok2 notes agents -\nReader tok3 notes agents -\nscan tok4 - - -\n");
  assert.equal(userOfClaim(credentials, "Writer", "scan")?.user, "Writer");
  assert.equal(userOfClaim(credentials, "writer", "scan")?.user, "Writer", "an identity provider that folds names to lower case");
  assert.equal(userOfClaim(credentials, "reader", "scan")?.user, "reader", "an exact match wins");
  assert.equal(userOfClaim(credentials, "READER", "scan"), null, "two lines differ only in case: no guess");
  assert.equal(userOfClaim(credentials, "nobody", "scan"), null);
  assert.equal(userOfClaim(credentials, "scan", "scan"), null);
  assert.equal(userOfClaim(credentials, "Scan", "scan"), null);
});
