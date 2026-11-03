// Runs the matrix with two allowlists and prints a Markdown table.
//   node run.ts
import { checkPage } from "./filter.ts";
import { cases } from "./cases.ts";

const lists: Record<string, string[]> = {
  minimal: ["query", "template.*"],
  extended: ["query", "template.*", "index.*", "string.*", "views.*"],
};

console.log("| id | case | expected | minimal | extended | reasons (extended list) |");
console.log("|---|---|---|---|---|---|");
let mismatches = 0;
for (const c of cases) {
  const cells: string[] = [];
  let reasons = "";
  for (const [name, allow] of Object.entries(lists)) {
    const v = checkPage(c.page, allow);
    const verdict = v.ok ? "accept" : "reject";
    cells.push(verdict === c.expect ? verdict : `**${verdict}**`);
    if (name === "extended") {
      reasons = [...new Set(v.violations.map((x) => `${x.rule}: ${x.detail}`))].join("; ");
      if (verdict !== c.expect) mismatches++;
    }
  }
  console.log(`| ${c.id} | ${c.name} | ${c.expect} | ${cells.join(" | ")} | ${reasons.replaceAll("|", "\\|")} |`);
}
console.log(`\n${cases.length} cases, ${mismatches} differ from the expectation with the extended list (bold cells).`);
