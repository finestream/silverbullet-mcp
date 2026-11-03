// The HTTP side: `/healthz`, and `/mcp` as stateless streamable HTTP. Each
// request is authenticated with a static bearer in the Authorization header
// (phase-1 auth, docs/architecture.md, section 2), then served by its own
// McpServer whose tools are bound to that user.

import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Credential, Credentials } from "./credentials.ts";
import { Cache, registerTools, type Context } from "./tools.ts";
import type { State } from "./state.ts";
import type { Log } from "./log.ts";

export type AuthModule = {
  /** The user behind a request, or null; the reason is logged, never sent. */
  authenticate(req: IncomingMessage): Credential | null;
};

/** Phase 1: a static bearer, compared by hash against the credentials file. */
export function staticBearerAuth(credentials: () => Credentials | null): AuthModule {
  return {
    authenticate(req) {
      const header = req.headers.authorization;
      if (!header || !header.startsWith("Bearer ")) return null;
      const bearer = header.slice(7).trim();
      if (!bearer) return null;
      return credentials()?.byBearer(bearer) ?? null;
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
  context: (user: Credential) => Omit<Context, "user" | "cache">;
  state: State;
  log: Log;
  rateLimit: number;
  version: string;
  /** Whether the server's configuration lets it serve at all (credentials readable). */
  configured: () => { ok: boolean; problems: string[] };
};

const json = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(body));
};

const rpcError = (res: ServerResponse, status: number, code: number, message: string, headers: Record<string, string> = {}) =>
  json(res, status, { jsonrpc: "2.0", error: { code, message }, id: null }, headers);

export function createHttpServer(deps: HttpDeps): Server {
  const cache = new Cache();
  const limiter = new RateLimiter(deps.rateLimit);

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/healthz") {
      const configured = deps.configured();
      const spaces = Object.fromEntries([...deps.state.spaces.values()].map((s) => [s.space, { guarded: s.guarded, transform: s.transform, findings: s.findings.length, files: s.files.length, lastScan: s.lastScan }]));
      return json(res, configured.ok ? 200 : 503, { ok: configured.ok, version: deps.version, problems: configured.problems, refusal: deps.state.globalRefusal(), scanning: deps.state.scanning, spaces });
    }
    if (url.pathname !== "/mcp") return json(res, 404, { error: "not found" });
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return rpcError(res, 405, -32000, "Method not allowed: this server is stateless; POST every request to /mcp.");
    }
    const user = deps.auth.authenticate(req);
    if (!user) {
      deps.log.info("auth.refused", { ip: req.socket.remoteAddress });
      return rpcError(res, 401, -32001, "Unauthorized: send a valid bearer in the Authorization header.", { "WWW-Authenticate": 'Bearer realm="silverbullet-mcp"' });
    }
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
