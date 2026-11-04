// The SilverBullet HTTP API as the server uses it: the file API of one space
// (`/<space>/.fs`) and the space configuration (`/<space>/.config`), every
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
}
