// Cost figures as a smoke test: they go to the report as measurements; the
// assertions only catch an order-of-magnitude change (docs/security.md,
// section 5; docs/architecture.md, "Cost of a runtime").

import test from "node:test";
import assert from "node:assert/strict";
import { parser as mdParser } from "@lezer/markdown";
import { checkPage } from "../write-filter/filter.ts";

const chunk = `## Section

A paragraph with a link to [[Some/Page]] and a reference \`${"${"}1 + 1}\` in a code span. Lorem ipsum dolor sit amet,
consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.

* an item with ${"${"}template.each(query[[from p = index.tag "page" where string.startsWith(p.name, "Agent/") limit 5]], templates.pageItem)}
* another item, plain
* [ ] a task

| a | b | c |
|---|---|---|
| 1 | 2 | 3 |
| 4 | 5 | ${"${"}2 * 3} |

\`\`\`lua
function example() return 1 end
\`\`\`

`;

function median(fn: () => unknown, runs = 30) {
  fn();
  const samples: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    fn();
    samples.push(performance.now() - t0);
  }
  samples.sort((a, b) => a - b);
  return samples[Math.floor(samples.length / 2)];
}

test("cost: the write filter checks a 50 KB page with ~200 directives in well under 100 ms", (t) => {
  let page = "";
  while (page.length < 50 * 1024) page += chunk;
  const allow = ["query", "template.*", "templates.*", "index.*", "views.*", "string.*"];
  const verdict = checkPage(page, allow);
  assert.ok(verdict.ok, "the benchmark page is accepted");
  const md = median(() => mdParser.parse(page));
  const full = median(() => checkPage(page, allow));
  t.diagnostic(`measure: filter, 50 KB page, ${verdict.directives} directives = ${full.toFixed(1)} ms (markdown parse alone ${md.toFixed(1)} ms)`);
  assert.ok(full < 100, `${full.toFixed(1)} ms per 50 KB page`);
});

test("cost: memory per runtime", (t) => {
  t.skip("not measured here: needs the container's cgroup (about 175 MiB per runtime was measured on 2.12.1 in Docker)");
});
