// Cost of the filter on a ~50 KB page.
//   node bench.ts
import { checkPage } from "./filter.ts";
import { parser as mdParser } from "@lezer/markdown";

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
let page = "";
while (page.length < 50 * 1024) page += chunk;
const allow = ["query", "template.*", "index.*", "string.*", "views.*"];

function time(label: string, fn: () => unknown, runs = 50) {
  fn(); // warm-up
  const samples: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    fn();
    samples.push(performance.now() - t0);
  }
  samples.sort((a, b) => a - b);
  const median = samples[Math.floor(samples.length / 2)];
  console.log(`${label}: median ${median.toFixed(2)} ms, min ${samples[0].toFixed(2)}, max ${samples[samples.length - 1].toFixed(2)} (${runs} runs)`);
  return median;
}

console.log(`page: ${(page.length / 1024).toFixed(1)} KB, ${page.split("\n").length} lines, ${(page.match(/\$\{/g) ?? []).length} \${ occurrences`);
const v = checkPage(page, allow);
console.log(`verdict: ${v.ok ? "accept" : "reject"}, ${v.directives} directives checked`);
time("markdown parse only", () => mdParser.parse(page));
const full = time("full filter (markdown + every directive)", () => checkPage(page, allow));
console.log(`estimate for 3000 such pages, sequential: ${(full * 3000 / 1000).toFixed(1)} s`);
