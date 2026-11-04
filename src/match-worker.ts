// The worker of match.ts: compiles the pattern and counts matches per item,
// per line when asked. Terminated by the main thread when it takes too long.

import { parentPort, workerData } from "node:worker_threads";
import type { MatchItem, MatchResult } from "./match.ts";

const { pattern, flags, items } = workerData as { pattern: string; flags: string; items: MatchItem[] };
const re = new RegExp(pattern, flags.includes("g") ? flags : flags + "g");
const count = (s: string) => {
  let n = 0;
  re.lastIndex = 0;
  while (re.exec(s) !== null) {
    n++;
    if (re.lastIndex === 0) break; // an empty match would loop forever
  }
  return n;
};
const out: MatchResult[] = [];
for (const item of items) {
  if (item.lines) {
    const lines: Array<[number, number]> = [];
    item.text.split("\n").forEach((line, i) => {
      const n = count(line);
      if (n > 0) lines.push([i, n]);
    });
    out.push({ id: item.id, count: lines.reduce((a, [, n]) => a + n, 0), lines });
  } else {
    out.push({ id: item.id, count: count(item.text) });
  }
}
parentPort!.postMessage(out);
