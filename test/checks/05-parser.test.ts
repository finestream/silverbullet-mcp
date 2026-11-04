// The vendored Lua parser and the write filter built on it (docs/security.md,
// section 5; docs/facts/write-filter.md). Needs the network for the comparison
// with the upstream tag; skipped without it.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { semver, version } from "../lib/env.ts";
import { checkPage } from "../../src/filter/filter.ts";
import { cases } from "../../src/filter/cases.ts";
import { shippedAllowlist } from "../../src/filter/allowlist.ts";

const VENDORED = ["lua.grammar", "parse-lua.js", "parse-lua.terms.js", "lua_comment.js"];
const UPSTREAM = "https://raw.githubusercontent.com/silverbulletmd/silverbullet";

test("filter: the test matrix passes with the shipped allowlist", () => {
  const wrong = cases
    .map((c) => ({ ...c, verdict: checkPage(c.page, shippedAllowlist()).ok ? "accept" : "reject" }))
    .filter((c) => c.verdict !== c.expect);
  assert.deepEqual(wrong.map((c) => `${c.id} ${c.name}: expected ${c.expect}, got ${c.verdict}`), []);
  assert.equal(cases.length, 73);
});

async function upstream(tag: string, path: string): Promise<string | null | undefined> {
  try {
    const r = await fetch(`${UPSTREAM}/${tag}/${path}`);
    if (r.status === 404) return null;
    if (!r.ok) return undefined;
    return await r.text();
  } catch {
    return undefined;
  }
}

test("parser: the four vendored files are unchanged at the running release's tag (needs network)", async (t) => {
  const tag = semver(await version());
  if (tag === "unknown") return t.skip("version unknown: the runtime is unavailable");
  const changed: string[] = [];
  for (const file of VENDORED) {
    const remote = await upstream(tag, `client/space_lua/${file}`);
    if (remote === undefined) return t.skip(`cannot fetch ${file} at tag ${tag}: no network?`);
    if (remote === null) return t.skip(`tag ${tag} has no client/space_lua/${file} on GitHub: an edge build or a moved file`);
    const local = readFileSync(new URL(`../../src/filter/vendor/silverbullet/${file}`, import.meta.url), "utf8");
    if (remote !== local) changed.push(file);
  }
  assert.deepEqual(changed, [], `re-vendor from tag ${tag} and review the grammar diff`);
});

test("parser: the pinned @lezer versions match SilverBullet's package.json at the tag (needs network)", async (t) => {
  const tag = semver(await version());
  if (tag === "unknown") return t.skip("version unknown");
  const remote = await upstream(tag, "package.json");
  if (!remote) return t.skip(`cannot fetch package.json at tag ${tag}`);
  const theirs = JSON.parse(remote).dependencies as Record<string, string>;
  const ours = createRequire(import.meta.url)("../../package.json").dependencies as Record<string, string>;
  const diff = Object.entries(ours)
    .filter(([k]) => k.startsWith("@lezer/"))
    .filter(([k, v]) => theirs[k]?.replace(/^[\^~]/, "") !== v)
    .map(([k, v]) => `${k}: ours ${v}, theirs ${theirs[k]}`);
  assert.deepEqual(diff, []);
});
