import test from "node:test";
import assert from "node:assert/strict";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type CryptoKey, type JWK } from "jose";
import { CfAccessVerifier, loadCfAccessConfig, type CfAccessConfig } from "./cf-access.ts";

const TEAM = "https://team.cloudflareaccess.example";
const AUD = "4714c1358e65fe4b408ad6d432a5f878f08194bdb4752441fd56faefa9b2b6f2";
const CONFIG: CfAccessConfig = { issuer: TEAM, audience: AUD };

const { publicKey, privateKey } = await generateKeyPair("RS256");
const other = await generateKeyPair("RS256");
const elliptic = await generateKeyPair("ES256");
const jwk: JWK = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256", use: "sig" };
const ecJwk: JWK = { ...(await exportJWK(elliptic.publicKey)), kid: "ec1", alg: "ES256", use: "sig" };
const keys = createLocalJWKSet({ keys: [jwk, ecJwk] });
const verifier = new CfAccessVerifier(CONFIG, keys);

const now = () => Math.floor(Date.now() / 1000);

/** An assertion as Access signs it for a user; `claims` override, `undefined` removes. */
const assertion = (claims: Record<string, unknown> = {}, opts: { key?: CryptoKey; kid?: string; alg?: string } = {}) =>
  new SignJWT({ aud: [AUD], email: "alice@example.org", exp: now() + 300, iat: now(), nbf: now(), iss: TEAM, type: "app", identity_nonce: "n0nce", sub: "7335d417-61da-459d-899c-0a01c76a2f94", country: "CH", ...claims })
    .setProtectedHeader({ alg: opts.alg ?? "RS256", kid: opts.kid ?? "k1" })
    .sign(opts.key ?? privateKey);

test("access: an assertion of the team domain for this application, not expired, names its e-mail address", async () => {
  const r = await verifier.verify(await assertion());
  assert.equal(r.ok && r.email, "alice@example.org");
  const several = await verifier.verify(await assertion({ aud: ["another-application", AUD] }));
  assert.equal(several.ok, true, "the application is one of several audiences");
});

test("access: wrong audience, wrong issuer, expired, not yet valid and no expiry are rejected", async () => {
  const cases: Array<[string, Promise<string>, RegExp]> = [
    ["another application of the same team", assertion({ aud: ["f".repeat(64)] }), /claim "aud"/],
    ["no audience", assertion({ aud: undefined }), /claim "aud"/],
    ["another team", assertion({ iss: "https://other.cloudflareaccess.example" }), /claim "iss"/],
    ["the team domain with a trailing slash", assertion({ iss: TEAM + "/" }), /claim "iss"/],
    ["expired", assertion({ exp: now() - 120 }), /expired/],
    ["not yet valid", assertion({ nbf: now() + 600 }), /claim "nbf"/],
    ["no expiry", assertion({ exp: undefined }), /claim "exp"/],
  ];
  for (const [name, a, reason] of cases) {
    const r = await verifier.verify(await a);
    assert.equal(r.ok, false, name);
    assert.match(!r.ok ? r.reason : "", reason, name);
  }
});

test("access: another key, an unsigned assertion, an HMAC one keyed with the public key, another algorithm and garbage are rejected", async () => {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const payload = { iss: TEAM, aud: [AUD], exp: now() + 300, email: "alice@example.org" };
  const hmacKey = new TextEncoder().encode(JSON.stringify(jwk));
  const cases: Array<[string, string]> = [
    ["another key, same kid", await assertion({}, { key: other.privateKey })],
    ["an unknown kid", await assertion({}, { kid: "k2" })],
    ["alg none", `${b64({ alg: "none", typ: "JWT" })}.${b64(payload)}.`],
    ["HS256 with the public key as the secret", await new SignJWT(payload).setProtectedHeader({ alg: "HS256", kid: "k1" }).sign(hmacKey)],
    ["ES256, validly signed by a key of the set: Access signs with RS256 only", await assertion({}, { key: elliptic.privateKey, kid: "ec1", alg: "ES256" })],
    ["not a token", "alice@example.org"],
    ["empty parts", ".."],
  ];
  for (const [name, a] of cases) assert.equal((await verifier.verify(a)).ok, false, name);
});

test("access: an assertion without an e-mail address, as a service token has it, selects nobody; the reason names its claims, not their values", async () => {
  const service = await verifier.verify(await assertion({ email: undefined, identity_nonce: undefined, country: undefined, nbf: undefined, sub: "", common_name: "0123456789abcdef.access" }));
  assert.equal(service.ok, false);
  assert.match(!service.ok ? service.reason : "", /no "email" claim \(it carries: aud, common_name, exp, iat, iss, sub, type\)/);
  for (const value of ["", 7, ["alice@example.org"]]) assert.equal((await verifier.verify(await assertion({ email: value }))).ok, false, JSON.stringify(value));
});

test("access: configuration: off without the variables; both are needed; the team domain as a host name or a URL without a path", () => {
  assert.equal(loadCfAccessConfig({}), null);
  assert.throws(() => loadCfAccessConfig({ MCP_CF_ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.example" }), /needs both/);
  assert.throws(() => loadCfAccessConfig({ MCP_CF_ACCESS_AUD: AUD }), /needs both/);
  assert.deepEqual(loadCfAccessConfig({ MCP_CF_ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.example", MCP_CF_ACCESS_AUD: AUD }), CONFIG);
  assert.deepEqual(loadCfAccessConfig({ MCP_CF_ACCESS_TEAM_DOMAIN: ` ${TEAM}/ `, MCP_CF_ACCESS_AUD: ` ${AUD} ` }), CONFIG);
  assert.equal(new CfAccessVerifier(CONFIG, keys).certsUrl(), "https://team.cloudflareaccess.example/cdn-cgi/access/certs");
  assert.throws(() => loadCfAccessConfig({ MCP_CF_ACCESS_TEAM_DOMAIN: "http://team.cloudflareaccess.example", MCP_CF_ACCESS_AUD: AUD }), /must be an https URL/);
  assert.throws(() => loadCfAccessConfig({ MCP_CF_ACCESS_TEAM_DOMAIN: TEAM + "/cdn-cgi/access/certs", MCP_CF_ACCESS_AUD: AUD }), /the team domain alone/);
  assert.throws(() => loadCfAccessConfig({ MCP_CF_ACCESS_TEAM_DOMAIN: TEAM, MCP_CF_ACCESS_AUD: "https://mcp.example.org/mcp" }), /AUD tag/);
  assert.equal(loadCfAccessConfig({ MCP_CF_ACCESS_TEAM_DOMAIN: "http://127.0.0.1:8080", MCP_CF_ACCESS_AUD: AUD })?.issuer, "http://127.0.0.1:8080");
});
