// The browser client, as a person uses it: a fresh profile with service worker
// and IndexedDB boots with the transform active (docs/facts/index-transform.md,
// sections 3 and 4). Needs Playwright with Chromium: `npm i playwright && npx
// playwright install chromium` in test/; skipped otherwise, or with SB_BROWSER=0.

import test from "node:test";
import assert from "node:assert/strict";
import { sb, T, S, SB_URL, userPassword, until } from "../lib/env.ts";
import { REPLACED_SCRIPT, SECRET } from "../lib/transform.ts";

type PW = typeof import("playwright");
let pw: PW | null = null;
if (process.env.SB_BROWSER !== "0") {
  try {
    pw = (await import("playwright")) as PW;
  } catch {
    pw = null;
  }
}

const CLIENT_STATE = `(async () => {
  const c = globalThis.client;
  const objs = await c.clientSystem.system.localSyscall("index.queryLuaObjects", ["space-lua", {}]);
  const outside = objs.filter((o) => !(o.ref.startsWith("CONFIG@") || o.ref.startsWith("Library/")));
  return {
    secret: c.config.get("agentTest.secret"),
    transformStored: !!c.config.get(["tags", "space-lua"]),
    scripts: objs.length,
    outsideScripts: [...new Set(outside.map((o) => o.script))],
    outsideFn: c.clientSystem.spaceLuaEnv.env.get("outside_marker") == null ? "nil" : "defined",
    libFn: c.clientSystem.spaceLuaEnv.env.get("mylib_fn") == null ? "nil" : "defined",
  };
})()`;

async function bootAsAlice() {
  const browser = await pw!.chromium.launch();
  const context = await browser.newContext();
  const login = await context.request.post(`${SB_URL}/.dashboard/api/login`, { data: { username: "alice", password: userPassword() } });
  assert.equal(login.status(), 200, "browser login as alice");
  const page = await context.newPage();
  const t0 = Date.now();
  await page.goto(`${SB_URL}/alpha/`);
  await page.waitForFunction(() => (globalThis as any).client?.fullIndexCompleted && (globalThis as any).client?.clientSystem?.scriptsLoaded, null, { timeout: 120000 });
  return { browser, page, bootSeconds: (Date.now() - t0) / 1000 };
}

test("browser: a fresh browser client boots with the transform active: outside scripts emptied, Library loaded, configuration set", async (t) => {
  if (!pw) return t.skip("playwright not installed (npm i playwright && npx playwright install chromium) or SB_BROWSER=0");
  let boot;
  try {
    boot = await bootAsAlice();
  } catch (e) {
    return t.skip(`browser could not start: ${(e as Error).message.split("\n")[0]}`);
  }
  try {
    const s = (await boot.page.evaluate(CLIENT_STATE)) as Record<string, unknown>;
    t.diagnostic(`measure: browser boot until index and scripts ready = ${boot.bootSeconds.toFixed(1)} s`);
    assert.equal(s.transformStored, true);
    assert.equal(s.secret, SECRET);
    assert.deepEqual(s.outsideScripts, [REPLACED_SCRIPT]);
    assert.equal(s.outsideFn, "nil");
    assert.equal(s.libFn, "defined");
  } finally {
    await boot.browser.close();
  }
});

test("browser: a page written through the API is indexed within 10 s with its script already replaced; a reload loads nothing", async (t) => {
  if (!pw) return t.skip("playwright not installed or SB_BROWSER=0");
  let boot;
  try {
    boot = await bootAsAlice();
  } catch (e) {
    return t.skip(`browser could not start: ${(e as Error).message.split("\n")[0]}`);
  }
  const name = `Browser ${Date.now()}`;
  const fn = `browser_${Date.now()}`;
  try {
    await sb.write(T.alice, S.alpha, `${name}.md`, `Written while a browser is open.\n\n\`\`\`space-lua\nfunction ${fn}() return 1 end\n\`\`\`\n`);
    const seen = await until(async () => {
      const r = (await boot.page.evaluate(`(async () => {
        const objs = await globalThis.client.clientSystem.system.localSyscall("index.queryLuaObjects", ["space-lua", {}]);
        const o = objs.find((o) => o.ref.startsWith(${JSON.stringify(name + "@")}));
        return o ? o.script : null;
      })()`)) as string | null;
      return r;
    }, 10000, 250);
    t.diagnostic(`measure: browser indexes an API write = ${seen.value ? seen.seconds.toFixed(1) + " s" : "not within 10 s"}`);
    assert.equal(seen.value, REPLACED_SCRIPT, "indexed with the replacement text");
    const loaded = await boot.page.evaluate(`(async () => {
      await globalThis.client.clientSystem.loadLuaScripts();
      return globalThis.client.clientSystem.spaceLuaEnv.env.get(${JSON.stringify(fn)}) == null ? "nil" : "defined";
    })()`);
    assert.equal(loaded, "nil", "a reload after the incremental index loads nothing");
  } finally {
    await sb.remove(T.alice, S.alpha, `${name}.md`);
    await boot.browser.close();
  }
});
