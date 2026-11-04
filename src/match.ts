// User-supplied regular expressions (search-notes, namePattern) are matched in
// a worker thread with a time limit: a pattern with catastrophic backtracking
// would otherwise block the server's single thread for every user.

import { Worker } from "node:worker_threads";

export type MatchItem = { id: string; text: string; lines: boolean };
/** `count` over the whole text; `lines` as [lineIndex, countOnThatLine] when asked for. */
export type MatchResult = { id: string; count: number; lines?: Array<[number, number]> };

export class MatchTimeout extends Error {
  constructor(ms: number) {
    super(`The pattern took more than ${ms} ms to match; simplify it (useRegex=false matches the text literally).`);
    this.name = "MatchTimeout";
  }
}

export function matchAll(pattern: string, flags: string, items: MatchItem[], timeoutMs = 2000): Promise<MatchResult[]> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./match-worker.ts", import.meta.url), { workerData: { pattern, flags, items } });
    const timer = setTimeout(() => {
      void worker.terminate();
      reject(new MatchTimeout(timeoutMs));
    }, timeoutMs);
    worker.once("message", (results: MatchResult[]) => {
      clearTimeout(timer);
      void worker.terminate();
      resolve(results);
    });
    worker.once("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}
