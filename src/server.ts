// The HTTP side: `/healthz`, the Protected Resource Metadata when OAuth is
// configured, and `/mcp` as stateless streamable HTTP. Each request is
// authenticated by the bearer in the Authorization header, a static bearer or
// an OAuth access token (docs/architecture.md, section 2), then served by its
// own McpServer whose tools are bound to that user.

import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Credential, Credentials } from "./credentials.ts";
import { Cache, registerTools, type Context } from "./tools.ts";
import type { State } from "./state.ts";
import type { Log } from "./log.ts";
import type { OAuthVerifier, Rejected } from "./oauth.ts";

/** The user behind a request, or why there is none. The reason is logged, never sent. */
export type AuthResult = { user: Credential; via: "bearer" | "oauth" } | { user: null; reason: string; error?: Rejected["error"] };

export type AuthModule = {
  authenticate(req: IncomingMessage): Promise<AuthResult>;
};

const bearerOf = (req: IncomingMessage): string | null => {
  const header = req.headers.authorization;
  if (!header || !/^Bearer /i.test(header)) return null;
  return header.slice(7).trim() || null;
};

/** A static bearer, compared by hash against the credentials file. */
export function staticBearerAuth(credentials: () => Credentials | null): AuthModule {
  return {
    async authenticate(req) {
      const bearer = bearerOf(req);
      if (!bearer) return { user: null, reason: "no bearer" };
      const user = credentials()?.byBearer(bearer) ?? null;
      return user ? { user, via: "bearer" } : { user: null, reason: "unknown bearer" };
    },
  };
}

/**
 * The user a verified token names: the line of the credentials file with that name, or, when
 * no line has it exactly, the only line that has it in another case (an identity provider may
 * fold user names to lower case). Never the scan's technical user, which has no client.
 */
export function userOfClaim(credentials: Credentials, username: string, scanUser: string): Credential | null {
  let user = credentials.users.get(username) ?? null;
  if (!user) {
    const folded = [...credentials.users.values()].filter((u) => u.user.toLowerCase() === username.toLowerCase());
    user = folded.length === 1 ? folded[0] : null;
  }
  return user && user.user !== scanUser ? user : null;
}

/**
 * A static bearer first (local clients without OAuth), then an OAuth access token: verified,
 * and mapped by its user claim to the same credentials file. Everything after that is the same
 * for both.
 */
export function bearerOrOAuth(credentials: () => Credentials | null, oauth: OAuthVerifier, scanUser: string): AuthModule {
  return {
    async authenticate(req) {
      const bearer = bearerOf(req);
      if (!bearer) return { user: null, reason: "no bearer" };
      const known = credentials();
      if (!known) return { user: null, reason: "no credentials file" };
      const byBearer = known.byBearer(bearer);
      if (byBearer) return { user: byBearer, via: "bearer" };
      const verified = await oauth.verify(bearer);
      if (!verified.ok) return { user: null, reason: verified.reason, error: verified.error };
      const user = userOfClaim(known, verified.username, scanUser);
      if (!user) return { user: null, reason: `the token's user "${verified.username.slice(0, 80)}" has no line in the credentials file`, error: "invalid_token" };
      return { user, via: "oauth" };
    },
  };
}

/** Tool calls per user and minute. */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();
  private readonly perMinute: number;

  constructor(perMinute: number) {
    this.perMinute = perMinute;
  }
  allow(user: string): boolean {
    if (this.perMinute <= 0) return true;
    const now = Date.now();
    const list = (this.hits.get(user) ?? []).filter((t) => now - t < 60_000);
    if (list.length >= this.perMinute) {
      this.hits.set(user, list);
      return false;
    }
    list.push(now);
    this.hits.set(user, list);
    return true;
  }
}

export type HttpDeps = {
  auth: AuthModule;
  /** The OAuth resource server, when configured: its metadata is served and its challenge sent. */
  oauth?: OAuthVerifier | null;
  context: (user: Credential) => Omit<Context, "user" | "cache">;
  state: State;
  log: Log;
  rateLimit: number;
  version: string;
  /** Whether the server's configuration lets it serve at all (credentials readable). */
  configured: () => { ok: boolean; problems: string[] };
};

/** The largest request the server reads; a page is at most 1,000,000 characters. */
const MAX_BODY = 4 * 1024 * 1024;

const json = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(body));
};

const rpcError = (res: ServerResponse, status: number, code: number, message: string, headers: Record<string, string> = {}) =>
  json(res, status, { jsonrpc: "2.0", error: { code, message }, id: null }, headers);

export function createHttpServer(deps: HttpDeps): Server {
  const cache = new Cache();
  const limiter = new RateLimiter(deps.rateLimit);
  const refused = new RateLimiter(30);

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/healthz") {
      // Unauthenticated: says whether the server can serve, nothing about the spaces (the log and the report page do).
      const configured = deps.configured();
      const ok = configured.ok && deps.state.globalRefusal() === null;
      return json(res, ok ? 200 : 503, { ok, version: deps.version, scanning: deps.state.scanning });
    }
    if (deps.oauth && deps.oauth.metadataPaths().includes(url.pathname)) {
      // Public by design (RFC 9728): it says where to get a token, nothing about users or spaces.
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.setHeader("Allow", "GET, HEAD");
        return json(res, 405, { error: "method not allowed" });
      }
      return json(res, 200, deps.oauth.metadata(), { "Cache-Control": "max-age=3600", "Access-Control-Allow-Origin": "*" });
    }
    if (url.pathname !== "/mcp") return json(res, 404, { error: "not found" });
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return rpcError(res, 405, -32000, "Method not allowed: this server is stateless; POST every request to /mcp.");
    }
    const length = Number(req.headers["content-length"]);
    if (!Number.isFinite(length)) return rpcError(res, 411, -32000, "Content-Length is required.");
    if (length > MAX_BODY) return rpcError(res, 413, -32000, `The request body is larger than ${MAX_BODY} bytes.`);
    const auth = await deps.auth.authenticate(req).catch((e): AuthResult => ({ user: null, reason: `authentication failed: ${(e as Error).message}` }));
    if (!auth.user) {
      const ip = req.socket.remoteAddress ?? "?";
      deps.log.info("auth.refused", { ip, reason: auth.reason });
      // Guessing bearers: a few refusals per minute and address, then 429.
      if (!refused.allow(ip)) return rpcError(res, 429, -32002, "Too many refused requests from this address.", { "Retry-After": "60" });
      if (auth.error === "insufficient_scope") {
        return rpcError(res, 403, -32001, "Forbidden: the access token lacks a required scope.", { "WWW-Authenticate": deps.oauth!.challenge(auth.error) });
      }
      const challenge = deps.oauth ? deps.oauth.challenge(auth.error) : 'Bearer realm="silverbullet-mcp"';
      return rpcError(res, 401, -32001, "Unauthorized: send a valid bearer in the Authorization header.", { "WWW-Authenticate": challenge });
    }
    const user = auth.user;
    if (!limiter.allow(user.user)) {
      deps.log.warn("rate.limited", { user: user.user });
      return rpcError(res, 429, -32002, `Rate limit: more than ${deps.rateLimit} requests per minute for this user.`, { "Retry-After": "60" });
    }
    const server = new McpServer({ name: "silverbullet-mcp", version: deps.version });
    registerTools(server, { ...deps.context(user), user, cache });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (e) {
      deps.log.error("mcp.request.failed", { user: user.user, error: (e as Error).message });
      if (!res.headersSent) rpcError(res, 500, -32603, "Internal error.");
      else if (!res.writableEnded) res.end();
    }
  });
}
