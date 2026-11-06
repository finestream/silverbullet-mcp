// Transclusions as the write filter's rule reads them (docs/security.md,
// section 5): which forms SilverBullet expands, where, and which it leaves
// alone. The rule refuses every form asserted here to expand; a form that
// starts to expand in a later release must be added to the filter.

import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { sb, T, S } from "../lib/env.ts";
import { checkPage } from "../../src/filter/filter.ts";
import { shippedAllowlist } from "../../src/filter/allowlist.ts";

const TARGET = "Transcluded/Deep";
const MARKER = "marker-transcluded";

before(async () => {
  await sb.write(T.admin, S.gamma, `${TARGET}.md`, `${MARKER}-top\n\n## Part\n${MARKER}-part\n`);
  await sb.write(T.admin, S.gamma, "Transcluded/note.txt", `${MARKER}-file\n`);
  await sb.runtimeReady(T.alice, S.gamma);
});

after(async () => {
  await sb.remove(T.admin, S.gamma, `${TARGET}.md`);
  await sb.remove(T.admin, S.gamma, "Transcluded/note.txt");
});

const expand = async (markdown: string) => {
  const r = await sb.lua(T.alice, S.gamma, `return markdown.renderParseTree(markdown.expandMarkdown(markdown.parseMarkdown(${JSON.stringify(markdown)})))`);
  return String(r.result ?? r.error ?? r.raw);
};

/** The filter as a reader who may not read the target sees the page. */
const refused = (markdown: string) => !checkPage(markdown, shippedAllowlist(), { page: "Notes/Page", denied: (t) => (t.startsWith("Transcluded/") ? "no r" : null) }).ok;

const EXPANDED = [
  `![[${TARGET}]]`,
  `![[${TARGET}#Part]]`,
  `![[${TARGET}|alias]]`,
  `![[${TARGET}#Part|alias]]`,
  `![[${TARGET}@0]]`,
  `![[${TARGET}@L1C1]]`,
  `![[/${TARGET}]]`,
  `![[${TARGET}.md]]`,
  `![[^${TARGET}]]`,
  `<div>![[${TARGET}]]</div>`,
  `<!-- ![[${TARGET}]] -->`,
  `> ![[${TARGET}]]`,
  `* ![[${TARGET}]]`,
  `| a |\n|---|\n| ![[${TARGET}]] |`,
  `![x](/${TARGET})`,
  `![x](/${TARGET}.md)`,
  `![x](</${TARGET}>)`,
  `![x](/${TARGET}#Part)`,
  `<div>![x](/${TARGET})</div>`,
];

const NOT_EXPANDED = [
  `\`![[${TARGET}]]\``,
  "```\n![[" + TARGET + "]]\n```",
  `[[${TARGET}]]`,
  `!\\[[${TARGET}]]`,
  `! [[${TARGET}]]`,
  `![[${TARGET.toLowerCase()}]]`,
  `![[Deep]]`,
  `![[Transcluded/note.txt]]`,
];

test("transclusion: every form SilverBullet expands is one the write filter refuses for a reader without r on the target", async () => {
  const leaks: string[] = [];
  for (const form of EXPANDED) {
    const out = await expand(form);
    assert.ok(out.includes(MARKER), `expected to expand: ${form} -> ${out.slice(0, 80)}`);
    if (!refused(form)) leaks.push(form);
  }
  assert.deepEqual(leaks, [], "expanded by SilverBullet and accepted by the filter");
});

test("transclusion: code spans, code blocks, links, escapes, another case and a bare last segment are not expanded; a file that is not a page is not expanded as text", async () => {
  for (const form of NOT_EXPANDED) {
    const out = await expand(form);
    assert.ok(!out.includes(MARKER), `expected to stay: ${form} -> ${out.slice(0, 80)}`);
  }
});

test("[watch] transclusion: a transclusion that an expression returns as a string is not expanded by markdown.expandMarkdown (the editor does expand it, which the filter cannot see)", async () => {
  const out = await expand(`\${"![[${TARGET}]]"}`);
  assert.ok(!out.includes(MARKER), out.slice(0, 120));
  assert.ok(out.includes(`![[${TARGET}]]`));
});
