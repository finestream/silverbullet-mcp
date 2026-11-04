// The SilverBullet HTTP API as the server uses it: the file API of one space
// (`/<space>/.fs`), the space configuration (`/<space>/.config`) and the
// Runtime API (`/<space>/.runtime/*`, docs/architecture.md section 5), every
// call with the token of the user it acts as. SilverBullet's refusals are
// kept as they are (status and text) so that the tools can pass them through.

export type SbFile = {
  name: string;
  created?: number;
  lastModified: number;
  contentType: string;
  size: number;
  perm: "ro" | "rw";
};

export type SpaceConfig = { readOnly: boolean; spacePrefixes: string[] };

export class SbError extends Error {
  readonly status: number;
  readonly space: string;
  readonly path: string | null;
  readonly body: string;

  constructor(status: number, space: string, path: string | null, body: string) {
    super(SbError.describe(status, space, path, body));
    this.name = "SbError";
    this.status = status;
    this.space = space;
    this.path = path;
    this.body = body;
  }

  static describe(status: number, space: string, path: string | null, body: string): string {
    const where = path ? `${space}/${path}` : `space ${space}`;
    const text = body.trim().slice(0, 200);
    switch (status) {
      case 401:
        return `SilverBullet refused the user's token (401) for ${where}`;
      case 403:
        return `SilverBullet refused access (403${text ? `: ${text}` : ""}) for ${where}`;
      case 404:
        return `SilverBullet has no ${where} (404)`;
      case 412:
        return `SilverBullet refused the write (412): the revision has changed, or the file already exists; read it again`;
      default:
        return `SilverBullet answered ${status}${text ? `: ${text}` : ""} for ${where}`;
    }
  }
}

/** A refusal or failure of the Runtime API; the message says what it means and, for a 403, what the operator grants. */
export class RuntimeError extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly space: string;

  constructor(status: number, space: string, code: string | null, detail: string, timeoutSec?: number) {
    super(RuntimeError.describe(status, space, code, detail, timeoutSec));
    this.name = "RuntimeError";
    this.status = status;
    this.code = code;
    this.space = space;
  }

  static describe(status: number, space: string, code: string | null, detail: string, timeoutSec?: number): string {
    const text = detail.trim().slice(0, 300);
    switch (status) {
      case 0:
        return `cannot reach SilverBullet's Runtime API for space ${space}`;
      case 401:
        return `SilverBullet refused the user's token (401) on the Runtime API of space ${space}`;
      case 403:
        return `SilverBullet refused the Runtime API (403) for space ${space}: a render runs in a headless browser as this user, which needs Write access to the space and the Runtime API granted to the user in the space's access grid (Dashboard: the space's members, "Runtime API"). A read-only member cannot render.`;
      case 404:
        return code === "selector_not_found" ? `no visible element matches the selector (404)` : `SilverBullet has no space ${space} (404)`;
      case 400:
        return `SilverBullet refused the request (400${text ? `: ${text}` : ""})`;
      case 500:
        return `the script failed in the runtime of space ${space}: ${text || "no detail"}`;
      case 503:
        return `SilverBullet's Runtime API is unavailable (503${code ? `, ${code}` : ""}) for space ${space}: it is not enabled on the instance (Admin, Runtimes), or the headless browser could not start`;
      case 504:
        return `the runtime of space ${space} did not answer within ${timeoutSec ?? "the"} s (504)`;
      default:
        return `SilverBullet answered ${status}${text ? `: ${text}` : ""} on the Runtime API of space ${space}`;
    }
  }
}

export type ScreenshotOptions = { selector?: string; fullPage?: boolean };

const encodePath = (path: string) => path.split("/").map(encodeURIComponent).join("/");

export class SilverBullet {
  readonly url: string;

  constructor(url: string) {
    this.url = url;
  }

  private headers(token: string, extra: Record<string, string> = {}): Record<string, string> {
    return { Authorization: `Bearer ${token}`, "X-Sync-Mode": "true", ...extra };
  }

  private async call(token: string, space: string, path: string | null, init: RequestInit & { headers?: Record<string, string> } = {}) {
    const url = path === null ? `${this.url}/${space}/.config` : `${this.url}/${space}/.fs${path === "" ? "" : "/" + encodePath(path)}`;
    let r: Response;
    try {
      r = await fetch(url, { ...init, headers: this.headers(token, init.headers) });
    } catch (e) {
      throw new SbError(0, space, path, "cannot reach SilverBullet");
    }
    if (!r.ok) throw new SbError(r.status, space, path, await r.text());
    return r;
  }

  async config(token: string, space: string): Promise<SpaceConfig> {
    const r = await this.call(token, space, null);
    const json = (await r.json()) as Partial<SpaceConfig>;
    return { readOnly: json.readOnly === true, spacePrefixes: Array.isArray(json.spacePrefixes) ? json.spacePrefixes : [] };
  }

  async list(token: string, space: string): Promise<SbFile[]> {
    const r = await this.call(token, space, "");
    return (await r.json()) as SbFile[];
  }

  async read(token: string, space: string, path: string): Promise<{ etag: string | null; body: Buffer; contentType: string }> {
    const r = await this.call(token, space, path);
    return { etag: r.headers.get("etag"), body: Buffer.from(await r.arrayBuffer()), contentType: r.headers.get("content-type") ?? "" };
  }

  async write(
    token: string,
    space: string,
    path: string,
    body: string | Buffer,
    opts: { ifMatch?: string; ifNoneMatch?: string; contentType?: string } = {},
  ): Promise<{ etag: string | null }> {
    const headers: Record<string, string> = { "Content-Type": opts.contentType ?? (path.endsWith(".md") ? "text/markdown" : "application/octet-stream") };
    if (opts.ifMatch) headers["If-Match"] = opts.ifMatch;
    if (opts.ifNoneMatch) headers["If-None-Match"] = opts.ifNoneMatch;
    const r = await this.call(token, space, path, { method: "PUT", body: body as RequestInit["body"], headers });
    return { etag: r.headers.get("etag") };
  }

  async delete(token: string, space: string, path: string, opts: { ifMatch?: string } = {}): Promise<void> {
    const headers: Record<string, string> = {};
    if (opts.ifMatch) headers["If-Match"] = opts.ifMatch;
    await this.call(token, space, path, { method: "DELETE", headers });
  }

  /** `/<space>/.runtime/<endpoint>` as the user; the first call starts that user's headless browser for the space. */
  private async runtime(token: string, space: string, endpoint: string, timeoutSec: number, init: RequestInit & { headers?: Record<string, string> } = {}) {
    const url = `${this.url}/${space}/.runtime/${endpoint}`;
    let r: Response;
    try {
      r = await fetch(url, { ...init, headers: { Authorization: `Bearer ${token}`, "X-Timeout": String(timeoutSec), ...init.headers } });
    } catch {
      throw new RuntimeError(0, space, null, "");
    }
    if (!r.ok) {
      const text = await r.text();
      let body: { error?: string; code?: string } = {};
      try {
        body = JSON.parse(text);
      } catch {}
      throw new RuntimeError(r.status, space, body.code ?? null, body.error ?? text, timeoutSec);
    }
    return r;
  }

  /** Runs a Lua script in the user's runtime for the space and returns what it returned. */
  async lua(token: string, space: string, script: string, timeoutSec: number): Promise<unknown> {
    const r = await this.runtime(token, space, "lua_script", timeoutSec, { method: "POST", body: script, headers: { "Content-Type": "text/plain" } });
    const body = (await r.json()) as { result?: unknown };
    return body.result;
  }

  /** A PNG of what the runtime's browser shows; `selector` clips to the first matching element. */
  async screenshot(token: string, space: string, opts: ScreenshotOptions, timeoutSec: number): Promise<Buffer> {
    const q = new URLSearchParams();
    if (opts.selector) q.set("selector", opts.selector);
    if (opts.fullPage) q.set("fullPage", "1");
    const query = q.size ? `?${q}` : "";
    const r = await this.runtime(token, space, `screenshot${query}`, timeoutSec);
    return Buffer.from(await r.arrayBuffer());
  }
}
