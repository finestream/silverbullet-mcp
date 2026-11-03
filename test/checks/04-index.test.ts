// What the index holds and the index-time transform (docs/facts/execution-model.md,
// section 6; docs/facts/index-transform.md; docs/security.md, section 10).
// Runs as alice on alpha and rewrites CONFIG; the last step restores it.

import test, { after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { sb, T, S, sleep } from "../lib/env.ts";
import { STATE_SCRIPT, type State } from "../lib/lua.ts";
import { configPage, REPLACED_SCRIPT, REPLACED_STYLE, SECRET, SHIPPED_TRANSFORM, type ConfigVariant } from "../lib/transform.ts";

const state = async (prefix = "") => (await sb.lua(T.alice, S.alpha, `${prefix} ${STATE_SCRIPT}`)).result as State;
const setConfig = async (variant: ConfigVariant) => {
  const r = await sb.write(T.alice, S.alpha, "CONFIG.md", configPage(variant));
  assert.ok([200, 201, 204].includes(r.status), `CONFIG write: ${r.status}`);
  await sleep(1500); // let the write reach the runtime's client
};
/**
 * Reload, reindex, reload: the first reload installs the transform that CONFIG now holds (or clears it),
 * the reindex applies it; reindexSpace returns before it is done, and loadScripts is a no-op while the
 * index is busy, so the last reload is repeated.
 */
const reindexAndReload = async () => {
  await sb.lua(T.alice, S.alpha, "system.loadScripts() return 1");
  await sleep(500);
  await sb.lua(T.alice, S.alpha, "index.reindexSpace() return 1");
  await sleep(6000);
  await sb.lua(T.alice, S.alpha, "system.loadScripts() return 1");
  await sleep(1000);
  await sb.lua(T.alice, S.alpha, "system.loadScripts() return 1");
};
const freshRuntime = async () => {
  await sb.admin.resetRuntimes(T.admin);
  await sb.lua(T.alice, S.alpha, "return 1");
};

after(async () => {
  await setConfig("shipped");
  await reindexAndReload();
});

test("transform: the block the checks install is the shipped block of docs/security.md, verbatim", () => {
  const doc = readFileSync(new URL("../../docs/security.md", import.meta.url), "utf8");
  assert.ok(doc.includes(SHIPPED_TRANSFORM), "docs/security.md and test/lib/transform.ts differ");
});

test("index: space-lua objects carry the full script and a ref `page@offset`, no page field; CONFIG included (section 6)", async () => {
  const r = await sb.lua(T.alice, S.alpha, `return query[[from s = index.tag "space-lua" where string.startsWith(s.ref, "CONFIG@") select {ref = s.ref, script = s.script, page = s.page}]]`);
  const rows = r.result as Array<{ ref: string; script: string; page: unknown }>;
  assert.equal(rows.length, 1, r.raw);
  assert.match(rows[0].ref, /^CONFIG@\d+$/);
  assert.ok(rows[0].script.includes("agentTest.secret"), "the full source is in the index");
  assert.equal(rows[0].page ?? null, null, "no page field");
});

test("index: values set with config.set in CONFIG are readable from any expression (section 6)", async () => {
  assert.equal((await state()).secret, SECRET);
});

test("index: page objects exist for CONFIG and Library pages; contentPages drops meta pages only (section 6)", async () => {
  const r = await sb.lua(
    T.alice,
    S.alpha,
    `return {
  pages = query[[from p = index.tag "page" where p.name == "CONFIG" or p.name == "Library/Mine" select p.name]],
  content = query[[from p = index.contentPages() where p.name == "CONFIG" or p.name == "Library/Mine" or p.name == "Library/Std" select p.name]],
}`,
  );
  const { pages, content } = r.result as { pages: string[]; content: string[] };
  assert.deepEqual(pages.sort(), ["CONFIG", "Library/Mine"]);
  assert.ok(content.includes("CONFIG") && content.includes("Library/Mine"), `contentPages keeps CONFIG and Library/Mine: ${content}`);
  assert.ok(!content.includes("Library/Std"), "Library/Std is meta and dropped");
});

test("index: items are indexed by default, Library pages included; space.readPage returns CONFIG's source (section 6)", async () => {
  const r = await sb.lua(T.alice, S.alpha, `return {items = query[[from i = index.tag "item" where i.page == "Library/Mine" select i.name]], src = string.sub(space.readPage("CONFIG"), 1, 400)}`);
  const { items, src } = r.result as { items: string[]; src: string };
  assert.deepEqual(items, ["library item text"]);
  assert.ok(src.includes(SECRET), "CONFIG's source is readable");
});

test("transform: with the shipped block, outside space-lua and space-style objects are indexed with their code replaced and never load", async () => {
  const s = await state();
  assert.equal(s.transformStored, true, "config.tags[space-lua] holds the transform");
  assert.deepEqual(s.outsideScripts, [REPLACED_SCRIPT]);
  assert.deepEqual(s.styledStyles, [REPLACED_STYLE]);
  assert.equal(s.outsideFn, "nil", "the outside function did not load");
  assert.equal(s.libFn, "lib-ok", "the Library function loaded");
  assert.equal(s.secret, SECRET);
});

test("transform: pages outside stay in the index with their links (the object is kept, not dropped)", async () => {
  const r = await sb.lua(T.alice, S.alpha, `return {page = #query[[from p = index.tag "page" where p.name == "Outside"]], links = #query[[from l = index.tag "link" where l.page == "Outside"]]}`);
  assert.deepEqual(r.result, { page: 1, links: 1 }, r.raw);
});

test("transform: survives system.loadScripts(), system.reboot(), index.reindexSpace() and a fresh runtime", async () => {
  const confined = (s: State, step: string) => {
    assert.equal(s.transformStored, true, `${step}: transform stored`);
    assert.equal(s.outsideFn, "nil", `${step}: outside not loaded`);
    assert.equal(s.libFn, "lib-ok", `${step}: Library loaded`);
    assert.equal(s.secret, SECRET, `${step}: config set`);
    assert.deepEqual(s.outsideScripts, [REPLACED_SCRIPT], `${step}: outside script replaced`);
  };
  confined(await state("system.loadScripts()"), "loadScripts");
  confined(await state("system.reboot()"), "reboot");
  await reindexAndReload();
  confined(await state(), "reindex");
  await freshRuntime();
  confined(await state(), "fresh runtime");
});

test("[watch] transform: a transform returning {} drops the whole page from the index (defect in 2.12.1; the docs say `{}` means not indexed)", async () => {
  await setConfig("variantA");
  await reindexAndReload();
  const s = await state();
  await setConfig("shipped");
  await reindexAndReload();
  assert.equal(s.outsidePage, 0, "the Outside page is still indexed with the {} transform: the defect may be fixed, and the variant worth a second look");
});

test("transform: an index built without the transform keeps outside scripts and reloads run them; a reindex with the transform removes them", async () => {
  await setConfig("none");
  await reindexAndReload();
  let s = await state();
  assert.equal(s.transformStored, false, "no transform");
  assert.ok(s.outsideScripts[0]?.includes("outside_marker"), `the outside script is in the index with its code: ${JSON.stringify(s.outsideScripts)}`);
  assert.equal(s.outsideFn, "outside-ran", "and it ran");

  await setConfig("shipped");
  s = await state("system.loadScripts()");
  assert.equal(s.transformStored, true, "transform back");
  assert.equal(s.outsideFn, "outside-ran", "without a reindex the old objects still run");
  assert.ok(s.outsideScripts[0]?.includes("outside_marker"), "and the index is unchanged");

  await reindexAndReload();
  s = await state();
  assert.deepEqual(s.outsideScripts, [REPLACED_SCRIPT], "after the reindex the code is replaced");
  assert.equal(s.outsideFn, "nil", "and gone from the environment");
});

test("execution: scripts are not reloaded after the incremental index of a changed page (a planted block waits for the next reload)", async (t) => {
  await setConfig("none");
  await reindexAndReload();
  const name = `Planted ${Date.now()}`;
  const fn = `planted_${Date.now()}`;
  await sb.write(T.alice, S.alpha, `${name}.md`, `Planted.\n\n\`\`\`space-lua\nfunction ${fn}() return "planted-ran" end\n\`\`\`\n`);
  const t0 = Date.now();
  let indexed = false;
  while (Date.now() - t0 < 30000) {
    const r = await sb.lua(T.alice, S.alpha, `return #query[[from s = index.tag "space-lua" where string.startsWith(s.ref, ${JSON.stringify(name + "@")})]]`);
    if (r.result === 1) {
      indexed = true;
      break;
    }
    await sleep(500);
  }
  if (!indexed) {
    await sb.remove(T.alice, S.alpha, `${name}.md`);
    return t.skip("the runtime did not index the written page within 30 s (see the watch check on indexing); nothing to assert");
  }
  const before_ = await sb.lua(T.alice, S.alpha, `return ${fn} and "defined" or "nil"`);
  await sleep(3000);
  const later = await sb.lua(T.alice, S.alpha, `return ${fn} and "defined" or "nil"`);
  // The first loadScripts right after an index write is skipped (the index is busy); the second applies.
  await sb.lua(T.alice, S.alpha, "system.loadScripts() return 1");
  await sleep(1000);
  const reloaded = await sb.lua(T.alice, S.alpha, `system.loadScripts() return ${fn} and "defined" or "nil"`);
  await sb.remove(T.alice, S.alpha, `${name}.md`);
  assert.equal(before_.result, "nil", "not loaded when indexed");
  assert.equal(later.result, "nil", "still not loaded 3 s later");
  assert.equal(reloaded.result, "defined", "loaded by the next reload");
});

test("[watch] transform: CONFIG's own objects cannot be dropped: the configuration is rebuilt from the index after the first reload", async () => {
  await setConfig("dropConfig");
  await reindexAndReload();
  await freshRuntime();
  const s = await state();
  await setConfig("shipped");
  await reindexAndReload();
  await freshRuntime();
  assert.equal(s.libFn, "lib-ok", "Library still loads");
  assert.equal(s.secret ?? null, null, "config.set from CONFIG survives a reload now: CONFIG's objects could be dropped from the index after all");
});
