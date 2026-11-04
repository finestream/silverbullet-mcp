// The render path (docs/architecture.md, section 5; docs/security.md,
// section 12): render-note and screenshot-note over SilverBullet's Runtime
// API, as the calling user, so that the runtime is that user's for that
// space. One queue per (user, space): renders and screenshots on one runtime
// run one at a time, because the `_CTX` shim and navigate-then-capture are
// not concurrent-safe. A global cap bounds the Runtime API calls in flight,
// and every call has a deadline. Before a render, the index of the runtime is
// checked for the pages written through the server since that runtime last
// confirmed them; after a bounded wait the fallback is `system.reboot()` on
// that runtime, which re-indexes the space. The render script shadows the
// writing functions of `space` for the call; that is best-effort, documented
// as such: what makes rendering safe is that pages hold no code.

import { RuntimeError, type SilverBullet } from "./sb.ts";
import type { Credential } from "./credentials.ts";
import type { State, RuntimeInfo } from "./state.ts";
import type { Config } from "./config.ts";
import type { Log } from "./log.ts";

export type RenderDeps = { sb: SilverBullet; state: State; config: Config; log: Log };

export class RenderTimeout extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RenderTimeout";
  }
}

/** A Lua long-bracket string literal that cannot be closed by its content. */
export function luaString(s: string): string {
  let level = 0;
  while (s.includes("]" + "=".repeat(level) + "]")) level++;
  const eq = "=".repeat(level);
  return `[${eq}[\n${s}]${eq}]`; // Lua drops a newline right after the opening bracket
}

/** The functions of `space` that write; shadowed for the duration of a render or screenshot. */
const WRITING_FUNCTIONS = ["writePage", "deletePage", "writeFile", "deleteFile", "writeDocument", "deleteDocument"];

/**
 * Shadows the writing functions once (idempotent: a shadow left behind by an interrupted call is
 * not saved as the original). Globals are written through `_G`: in SilverBullet's Lua an
 * assignment to a bare name inside a function lands in a function-local environment that the
 * directives of the page do not see (measured on 2.12.1).
 */
const SHADOW = `
local function sbmcp_shadow()
  if _G.__sbmcp_saved == nil then
    local saved = {}
    for _, f in ipairs({${WRITING_FUNCTIONS.map((f) => JSON.stringify(f)).join(", ")}}) do
      saved[f] = space[f]
      space[f] = function() error("rendering is read-only") end
    end
    _G.__sbmcp_saved = saved
  end
end
local function sbmcp_restore()
  if _G.__sbmcp_saved ~= nil then
    for f, fn in pairs(_G.__sbmcp_saved) do space[f] = fn end
    _G.__sbmcp_saved = nil
  end
end`;

/**
 * The render script of the spike: `markdown.expandMarkdown` of the page's source, with the
 * writing functions shadowed. `expandMarkdown(text, {pageName})` is tried first (the edge
 * release); when the instance ignores it, `_CTX` is set by hand around the call (2.12.1 sets
 * none inside `expandMarkdown`), which is why calls on one runtime are serialised.
 */
export function renderScript(page: string): string {
  return `${SHADOW}
local name = ${luaString(page)}
sbmcp_shadow()
local ok, result = pcall(function()
  local text = space.readPage(name)
  local probeOk, probe = pcall(markdown.expandMarkdown, "\${_CTX.currentPage.name}", {pageName = name})
  if probeOk and type(probe) == "string" and string.find(probe, name, 1, true) ~= nil then
    return {markdown = markdown.expandMarkdown(text, {pageName = name}), shim = false}
  end
  local meta = index.getObjectByRef(name, "page", name) or space.getPageMeta(name)
  _G._CTX = {currentPage = meta}
  local expandOk, md = pcall(markdown.expandMarkdown, text)
  _G._CTX = nil
  if not expandOk then error(md) end
  return {markdown = md, shim = true}
end)
sbmcp_restore()
if not ok then error(result) end
return result`;
}

/** Shadows the writing functions and shows the page in the runtime's editor; the screenshot follows as a separate request. */
export function navigateScript(page: string): string {
  return `${SHADOW}
sbmcp_shadow()
editor.navigate(${luaString(page)})
return editor.getCurrentPage()`;
}

export const CURRENT_PAGE_SCRIPT = `return editor.getCurrentPage()`;
export const RESTORE_SCRIPT = `${SHADOW}
sbmcp_restore()
return true`;

/**
 * Which of the pages are not current in the runtime's index: the page object's `lastModified`
 * differs from the file's (both formatted by the client, so they are compared as they are),
 * or a deleted page still has an object.
 */
export function indexCheckScript(pages: string[]): string {
  return `local pages = {${pages.map(luaString).join(", ")}}
local stale = {}
for _, name in ipairs(pages) do
  local ok, meta = pcall(space.getPageMeta, name)
  local o = index.getObjectByRef(name, "page", name)
  if ok and meta ~= nil then
    if o == nil or o.lastModified ~= meta.lastModified then stale[#stale + 1] = name end
  elseif o ~= nil then
    stale[#stale + 1] = name
  end
end
return {count = #stale, pages = stale}`;
}

export const REBOOT_SCRIPT = `system.reboot()
return true`;

/** Serialises jobs: each starts when the previous one has settled. */
class Queue {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(job: () => Promise<T>): Promise<T> {
    const next = this.tail.then(job, job);
    this.tail = next.catch(() => {});
    return next;
  }
}

/** At most `n` holders at once; waiters are served in order. */
class Semaphore {
  private free: number;
  private readonly waiting: Array<() => void> = [];

  constructor(n: number) {
    this.free = n;
  }

  async acquire(): Promise<() => void> {
    if (this.free > 0) this.free--;
    else await new Promise<void>((resolve) => this.waiting.push(resolve));
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiting.shift();
      if (next) next();
      else this.free++;
    };
  }
}

export type RenderOutcome = {
  /** Milliseconds spent waiting for the queue and the global cap. */
  queuedMs: number;
  /** Milliseconds spent waiting for the runtime's index, reboot included. */
  indexWaitMs: number;
  rebooted: boolean;
  warnings: string[];
  runtime: RuntimeInfo;
};

export type RenderResult = RenderOutcome & { markdown: string; shim: boolean };
export type ScreenshotResult = RenderOutcome & { png: Buffer; width: number; height: number };

/** A runtime bound to one user, space and deadline. */
type Handle = {
  lua(script: string): Promise<unknown>;
  screenshot(opts: { selector?: string; fullPage?: boolean }): Promise<Buffer>;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class Renderer {
  private readonly d: RenderDeps;
  private readonly queues = new Map<string, Queue>();
  private readonly gate: Semaphore;

  constructor(d: RenderDeps) {
    this.d = d;
    this.gate = new Semaphore(Math.max(1, d.config.renderParallel));
  }

  render(user: Credential, space: string, page: string): Promise<RenderResult> {
    return this.onRuntime(user, space, async (rt) => {
      const r = (await rt.lua(renderScript(page))) as { markdown?: unknown; shim?: unknown };
      if (!r || typeof r.markdown !== "string") throw new Error("the render script returned no Markdown");
      return { markdown: r.markdown, shim: r.shim === true };
    });
  }

  screenshot(user: Credential, space: string, page: string, opts: { selector?: string; fullPage?: boolean }): Promise<ScreenshotResult> {
    return this.onRuntime(user, space, async (rt) => {
      try {
        const current = await rt.lua(navigateScript(page));
        // navigate returns once the page is shown; a short confirmation loop covers a slow switch.
        for (let i = 0; i < 20 && current !== page && (await rt.lua(CURRENT_PAGE_SCRIPT)) !== page; i++) await sleep(100);
        const png = await rt.screenshot(opts);
        const { width, height } = pngSize(png);
        return { png, width, height };
      } finally {
        await rt.lua(RESTORE_SCRIPT).catch(() => {});
      }
    });
  }

  /**
   * Runs `fn` on the user's runtime for the space: queued per (user, space), under the global
   * cap, within the deadline, after the index wait for the pending writes of the space.
   */
  private async onRuntime<T>(user: Credential, space: string, fn: (rt: Handle) => Promise<T>): Promise<T & RenderOutcome> {
    const { sb, state, config, log } = this.d;
    const key = `${user.user}/${space}`;
    const deadline = Date.now() + config.renderTimeout;
    const t0 = Date.now();
    let queue = this.queues.get(key);
    if (!queue) {
      queue = new Queue();
      this.queues.set(key, queue);
    }
    const remaining = () => {
      const sec = Math.ceil((deadline - Date.now()) / 1000);
      if (sec <= 0) throw new RenderTimeout(`The render did not complete within ${Math.round(config.renderTimeout / 1000)} s (MCP_RENDER_TIMEOUT).`);
      return sec;
    };
    return queue.run(async () => {
      remaining();
      const release = await this.gate.acquire();
      try {
        remaining();
        const queuedMs = Date.now() - t0;
        // The runtime counts as used once a Runtime API call succeeded: a refusal (403) starts no browser.
        const rt = state.runtimes.get(key) ?? { user: user.user, space, firstUsed: new Date(), lastUsed: new Date(), calls: 0, reboots: 0, confirmedSeq: 0 };
        rt.lastUsed = new Date();
        rt.calls++;
        const used = <T>(p: Promise<T>) =>
          p.then((v) => {
            if (!state.runtimes.has(key)) state.runtimes.set(key, rt);
            return v;
          });
        const handle: Handle = {
          lua: (script) => used(sb.lua(user.token, space, script, remaining())),
          screenshot: (opts) => used(sb.screenshot(user.token, space, opts, remaining())),
        };
        const t1 = Date.now();
        const { warnings, rebooted } = await this.ensureIndex(handle, rt, space);
        const indexWaitMs = Date.now() - t1;
        const out = await fn(handle);
        log.info("render", { user: user.user, space, queuedMs, indexWaitMs, rebooted, ms: Date.now() - t0 });
        return { ...out, queuedMs, indexWaitMs, rebooted, warnings, runtime: rt };
      } finally {
        release();
      }
    });
  }

  /**
   * The index wait of docs/security.md, section 12: the pages written through the server that
   * this runtime has not confirmed are checked in its index, bounded by `indexWait`; then the
   * runtime's client is rebooted (`system.reboot()`, as the same user), which re-indexes the
   * space, and checked once more. A page still missing is a warning on the result, not an error.
   */
  private async ensureIndex(rt: Handle, info: RuntimeInfo, space: string): Promise<{ warnings: string[]; rebooted: boolean }> {
    const { state, log } = this.d;
    const pending = state.pendingFor(space, info.confirmedSeq);
    if (pending.length === 0) return { warnings: [], rebooted: false };
    const pages = [...new Set(pending.map((w) => w.page))];
    const latest = Math.max(...pending.map((w) => w.seq));
    let stale = await this.waitForIndex(rt, pages);
    let rebooted = false;
    if (stale.length > 0) {
      log.warn("render.reboot", { user: info.user, space, stale });
      rebooted = true;
      info.reboots++;
      await rt.lua(REBOOT_SCRIPT);
      await this.waitForRuntime(rt);
      stale = await this.waitForIndex(rt, stale);
    }
    // One reboot per batch of writes: a page the index never takes is reported, not retried forever.
    info.confirmedSeq = Math.max(info.confirmedSeq, latest);
    const warnings = stale.length ? [`The runtime's index does not yet hold the latest revision of ${stale.map((p) => `"${p}"`).join(", ")}${rebooted ? " (even after a reboot of the runtime)" : ""}; queries over these pages may be stale.`] : [];
    if (stale.length) log.warn("render.index.stale", { user: info.user, space, stale, rebooted });
    return { warnings, rebooted };
  }

  /** Polls the index check until no page is stale or `indexWait` has passed; returns the pages still stale. */
  private async waitForIndex(rt: Handle, pages: string[]): Promise<string[]> {
    const until = Date.now() + this.d.config.indexWait;
    for (;;) {
      const r = (await rt.lua(indexCheckScript(pages))) as { count?: number; pages?: string[] } | null;
      const stale = r && typeof r.count === "number" && r.count > 0 && Array.isArray(r.pages) ? r.pages : [];
      if (stale.length === 0 || Date.now() >= until) return stale;
      await sleep(Math.min(300, Math.max(50, until - Date.now())));
    }
  }

  /** After a reboot the runtime may refuse scripts for a moment; waits until it answers again. */
  private async waitForRuntime(rt: Handle): Promise<void> {
    for (;;) {
      try {
        if ((await rt.lua("return 1")) === 1) return;
      } catch (e) {
        if (!(e instanceof RuntimeError) || e.status === 403 || e.status === 401) throw e;
      }
      await sleep(250);
    }
  }
}

/** Width and height of a PNG from its IHDR chunk; throws when the bytes are not a PNG. */
export function pngSize(png: Buffer): { width: number; height: number } {
  const signature = "89504e470d0a1a0a";
  if (png.length < 24 || png.subarray(0, 8).toString("hex") !== signature) throw new Error("the runtime did not return a PNG");
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}
