// OAuth 2.1 resource server (docs/architecture.md, section 2; docs/oauth.md):
// verifies access tokens issued by an external authorization server (issuer,
// audience = this server's resource URL, expiry, signature through the
// issuer's JWKS) and publishes the Protected Resource Metadata of RFC 9728.
// The server runs no authorization server of its own and never forwards a
// token: a verified token only selects the user's line in the credentials file.

import { createRemoteJWKSet, jwtVerify, errors, type JWTPayload, type JWTVerifyGetKey } from "jose";

export type OAuthConfig = {
  /** The issuer identifier of the authorization server, as its tokens carry it in `iss`. */
  issuer: string;
  /** This server's resource URL (RFC 8707): what a token's `aud` must contain, and what the metadata names. */
  resource: string;
  /** Where the issuer's keys are; null means: ask the issuer's metadata. */
  jwksUrl: string | null;
  /** The claim that names the user's line in the credentials file. */
  userClaim: string;
  /** Scopes every token must carry; also what the metadata and the challenge advertise. */
  scopes: string[];
};

/** Signature algorithms accepted: asymmetric only. `none` and the HMAC family can never verify a token here. */
export const ALGORITHMS = ["RS256", "RS384", "RS512", "PS256", "PS384", "PS512", "ES256", "ES384", "ES512", "EdDSA"];

/** Seconds of clock difference tolerated between the issuer and this server. */
const CLOCK_TOLERANCE = 30;
const METADATA_TIMEOUT = 10_000;
/** After a failed look-up of the issuer's metadata, how long until the next try. */
const METADATA_RETRY = 30_000;

export type Verified = { ok: true; username: string; claims: JWTPayload };
export type Rejected = { ok: false; error: "invalid_token" | "insufficient_scope"; reason: string };

/** Reads the OAuth settings; null when OAuth is off. Throws on a setting that cannot be right, so the server does not start half-configured. */
export function loadOAuthConfig(env: NodeJS.ProcessEnv): OAuthConfig | null {
  const issuer = env.MCP_OAUTH_ISSUER?.trim();
  const resource = env.MCP_OAUTH_RESOURCE?.trim();
  if (!issuer && !resource) return null;
  if (!issuer || !resource) throw new Error("OAuth needs both MCP_OAUTH_ISSUER and MCP_OAUTH_RESOURCE");
  const jwksUrl = env.MCP_OAUTH_JWKS_URL?.trim() || null;
  for (const [name, value] of [["MCP_OAUTH_ISSUER", issuer], ["MCP_OAUTH_RESOURCE", resource], ["MCP_OAUTH_JWKS_URL", jwksUrl]] as const) {
    if (value === null) continue;
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new Error(`${name} is not a URL: ${value}`);
    }
    const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
    if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) throw new Error(`${name} must be an https URL (http only for a loopback address): ${value}`);
    if (url.hash || url.username || url.password) throw new Error(`${name} must have no fragment and no credentials: ${value}`);
    if (name !== "MCP_OAUTH_JWKS_URL" && url.search) throw new Error(`${name} must have no query: ${value}`);
  }
  return {
    issuer,
    resource,
    jwksUrl,
    userClaim: env.MCP_OAUTH_USER_CLAIM?.trim() || "preferred_username",
    scopes: (env.MCP_OAUTH_SCOPES ?? "").split(/[\s,]+/).filter(Boolean),
  };
}

/**
 * Where the authorization server's metadata may be (RFC 8414 with the issuer's path appended,
 * OpenID Connect Discovery with the path appended and with the path in front), in the order
 * MCP clients try them.
 */
export function metadataUrls(issuer: string): string[] {
  const url = new URL(issuer);
  const path = url.pathname.replace(/\/+$/, "");
  return [
    `${url.origin}/.well-known/oauth-authorization-server${path}`,
    `${url.origin}/.well-known/openid-configuration${path}`,
    `${url.origin}${path}/.well-known/openid-configuration`,
  ].filter((u, i, all) => all.indexOf(u) === i);
}

export class OAuthVerifier {
  readonly config: OAuthConfig;
  private keys: JWTVerifyGetKey | null;
  private lastFailure = 0;
  private lastReason = "";
  private pending: Promise<JWTVerifyGetKey> | null = null;

  /** `keys` replaces the look-up of the issuer's JWKS, for tests. */
  constructor(config: OAuthConfig, keys?: JWTVerifyGetKey) {
    this.config = config;
    this.keys = keys ?? (config.jwksUrl ? createRemoteJWKSet(new URL(config.jwksUrl)) : null);
  }

  /** The issuer's keys: from the configured URL, or from the `jwks_uri` of the issuer's own metadata. */
  private async keySet(): Promise<JWTVerifyGetKey> {
    if (this.keys) return this.keys;
    if (this.pending) return this.pending;
    if (Date.now() - this.lastFailure < METADATA_RETRY) throw new Error(this.lastReason);
    this.pending = (async () => {
      const tried: string[] = [];
      for (const url of metadataUrls(this.config.issuer)) {
        try {
          const res = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(METADATA_TIMEOUT), redirect: "error" });
          if (!res.ok) {
            tried.push(`${url}: ${res.status}`);
            continue;
          }
          const meta = (await res.json()) as { issuer?: unknown; jwks_uri?: unknown };
          // RFC 8414, section 3.3: the metadata must name the issuer it was asked for.
          if (meta.issuer !== this.config.issuer) {
            tried.push(`${url}: names the issuer ${JSON.stringify(meta.issuer)}`);
            continue;
          }
          if (typeof meta.jwks_uri !== "string") {
            tried.push(`${url}: no jwks_uri`);
            continue;
          }
          this.keys = createRemoteJWKSet(new URL(meta.jwks_uri));
          return this.keys;
        } catch (e) {
          tried.push(`${url}: ${(e as Error).message}`);
        }
      }
      this.lastFailure = Date.now();
      this.lastReason = `the issuer's metadata is not available (${tried.join("; ")})`;
      throw new Error(this.lastReason);
    })().finally(() => {
      this.pending = null;
    });
    return this.pending;
  }

  /** Verifies an access token. The reason of a rejection is for the log; the client gets the error code only. */
  async verify(token: string): Promise<Verified | Rejected> {
    const reject = (reason: string, error: Rejected["error"] = "invalid_token"): Rejected => ({ ok: false, error, reason });
    let keys: JWTVerifyGetKey;
    try {
      keys = await this.keySet();
    } catch (e) {
      return reject((e as Error).message);
    }
    let claims: JWTPayload;
    try {
      const verified = await jwtVerify(token, keys, {
        issuer: this.config.issuer,
        audience: this.config.resource,
        algorithms: ALGORITHMS,
        clockTolerance: CLOCK_TOLERANCE,
        requiredClaims: ["exp", "iss", "aud"],
      });
      claims = verified.payload;
    } catch (e) {
      if (e instanceof errors.JWTExpired) return reject("the token has expired");
      if (e instanceof errors.JWTClaimValidationFailed) return reject(`claim "${e.claim}": ${e.reason} (${e.message})`);
      if (e instanceof errors.JOSEError) return reject(`${e.code}: ${e.message}`);
      return reject((e as Error).message);
    }
    const granted = typeof claims.scope === "string" ? claims.scope.split(" ") : [];
    const missing = this.config.scopes.filter((s) => !granted.includes(s));
    if (missing.length) return reject(`the token lacks the scope ${missing.join(" ")}`, "insufficient_scope");
    const username = claims[this.config.userClaim];
    if (typeof username !== "string" || !username) return reject(`the token has no "${this.config.userClaim}" claim`);
    return { ok: true, username, claims };
  }

  /** The paths the metadata is served at: the root form, and the form with the resource's path appended (RFC 9728, section 3.1). */
  metadataPaths(): string[] {
    const path = new URL(this.config.resource).pathname.replace(/\/+$/, "");
    const root = "/.well-known/oauth-protected-resource";
    return path ? [root + path, root] : [root];
  }

  /** The URL of the metadata, as the 401 challenge names it. */
  metadataUrl(): string {
    return new URL(this.config.resource).origin + this.metadataPaths()[0];
  }

  /** The Protected Resource Metadata (RFC 9728). */
  metadata(): Record<string, unknown> {
    return {
      resource: this.config.resource,
      authorization_servers: [this.config.issuer],
      bearer_methods_supported: ["header"],
      ...(this.config.scopes.length ? { scopes_supported: this.config.scopes } : {}),
      resource_name: "silverbullet-mcp",
    };
  }

  /** The `WWW-Authenticate` value of a 401 or 403 (RFC 6750, section 3; RFC 9728, section 5.1). */
  challenge(error?: Rejected["error"]): string {
    const parts = ['realm="silverbullet-mcp"', `resource_metadata="${this.metadataUrl()}"`];
    if (this.config.scopes.length) parts.push(`scope="${this.config.scopes.join(" ")}"`);
    if (error) parts.push(`error="${error}"`);
    return `Bearer ${parts.join(", ")}`;
  }
}
