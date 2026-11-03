// A small client for the SilverBullet HTTP API, as the checks use it: the file
// API (/.fs), the space configuration (/.config), the Runtime API
// (/.runtime/lua_script, /.runtime/screenshot), the event stream (/.events) and
// the admin API (/.dashboard/api). Every call takes the token of the user it
// acts as; nothing is cached.

export type LuaResult = { status: number; result?: unknown; error?: string; ms: number; raw: string };
export type AdminCredential = { cookie?: string; token?: string };

const encodePath = (path: string) => path.split("/").map(encodeURIComponent).join("/");

export function client(url: string) {
  const auth = (token?: string): Record<string, string> => (token ? { Authorization: `Bearer ${token}` } : {});

  const sb = {
    url,

    fs(token: string | undefined, space: string, path: string, init: RequestInit = {}) {
      return fetch(`${url}/${space}/.fs/${encodePath(path)}`, {
        ...init,
        headers: { ...auth(token), ...((init.headers as Record<string, string>) ?? {}) },
      });
    },

    async read(token: string | undefined, space: string, path: string) {
      const r = await sb.fs(token, space, path);
      return { status: r.status, etag: r.headers.get("etag"), headers: r.headers, text: await r.text() };
    },

    async write(token: string | undefined, space: string, path: string, body: string | Uint8Array, headers: Record<string, string> = {}) {
      const r = await sb.fs(token, space, path, { method: "PUT", body, headers });
      return { status: r.status, etag: r.headers.get("etag"), text: await r.text() };
    },

    async remove(token: string | undefined, space: string, path: string) {
      const r = await sb.fs(token, space, path, { method: "DELETE" });
      return { status: r.status, text: await r.text() };
    },

    async config(token: string | undefined, space: string) {
      const r = await fetch(`${url}/${space}/.config`, { headers: auth(token) });
      return { status: r.status, json: r.ok ? ((await r.json()) as Record<string, unknown>) : null };
    },

    /** Runs a Lua script in the user's runtime for that space; the runtime boots on the first call. */
    async lua(token: string, space: string, script: string, timeoutSec = 120): Promise<LuaResult> {
      const t0 = performance.now();
      const r = await fetch(`${url}/${space}/.runtime/lua_script`, {
        method: "POST",
        headers: { ...auth(token), "X-Timeout": String(timeoutSec) },
        body: script,
      });
      const raw = await r.text();
      let body: { result?: unknown; error?: string };
      try {
        body = JSON.parse(raw);
      } catch {
        body = { error: raw };
      }
      return { status: r.status, result: body.result, error: body.error, ms: Math.round(performance.now() - t0), raw };
    },

    /**
     * Waits until the user's runtime for the space answers a script (after a reset the server
     * answers "runtime not ready" for a while). Returns the time it took, or throws.
     */
    async runtimeReady(token: string, space: string, timeoutMs = 120000): Promise<number> {
      const t0 = performance.now();
      let last: LuaResult | undefined;
      while (performance.now() - t0 < timeoutMs) {
        last = await sb.lua(token, space, "return 1");
        if (last.status === 200 && last.result === 1) return Math.round(performance.now() - t0);
        await new Promise((r) => setTimeout(r, 500));
      }
      throw new Error(`runtime for ${space} not ready after ${timeoutMs} ms: ${last?.raw}`);
    },

    async screenshot(token: string, space: string, query = "") {
      const t0 = performance.now();
      const r = await fetch(`${url}/${space}/.runtime/screenshot${query}`, { headers: auth(token) });
      const png = Buffer.from(await r.arrayBuffer());
      const size = r.status === 200 && png.length > 24 ? { width: png.readUInt32BE(16), height: png.readUInt32BE(20) } : null;
      return { status: r.status, png, size, ms: Math.round(performance.now() - t0) };
    },

    /** Opens the server's event stream for a space; the caller aborts it. */
    events(token: string, space: string, signal: AbortSignal) {
      return fetch(`${url}/${space}/.events`, { headers: auth(token), signal });
    },

    admin: {
      async login(username: string, password: string): Promise<string> {
        const r = await fetch(`${url}/.dashboard/api/login`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username, password }),
        });
        const cookie = r.headers.get("set-cookie")?.split(";")[0];
        if (!r.ok || !cookie) throw new Error(`admin login failed: ${r.status} ${await r.text()}`);
        return cookie;
      },

      async api(cred: AdminCredential, method: string, path: string, body?: unknown) {
        const headers: Record<string, string> = {};
        if (cred.cookie) headers.Cookie = cred.cookie;
        if (cred.token) headers.Authorization = `Bearer ${cred.token}`;
        if (body !== undefined) headers["Content-Type"] = "application/json";
        const r = await fetch(`${url}/.dashboard/api${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
        const text = await r.text();
        let json: unknown = null;
        try {
          json = JSON.parse(text);
        } catch {}
        return { status: r.status, json, text };
      },

      /** The runtimes SilverBullet currently keeps (one per user and space that used the Runtime API). */
      async runtimes(token: string): Promise<Array<{ id: string; [k: string]: unknown }>> {
        const { status, json } = await sb.admin.api({ token }, "GET", "/admin/runtimes");
        if (status !== 200) throw new Error(`admin runtimes: ${status}`);
        const list = Array.isArray(json) ? json : ((json as { runtimes?: unknown[] })?.runtimes ?? []);
        return list as Array<{ id: string }>;
      },

      /** Resets every runtime, so that the next Runtime API call boots a fresh client. */
      async resetRuntimes(token: string) {
        const list = await sb.admin.runtimes(token);
        for (const rt of list) await sb.admin.api({ token }, "POST", `/admin/runtimes/${rt.id}/reset`);
        return list.length;
      },

      async stopRuntimes(token: string) {
        const list = await sb.admin.runtimes(token);
        for (const rt of list) await sb.admin.api({ token }, "POST", `/admin/runtimes/${rt.id}/stop`);
        return list.length;
      },
    },
  };
  return sb;
}

export type Client = ReturnType<typeof client>;
