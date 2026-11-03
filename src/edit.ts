// The conditional edit engine: exact, case-sensitive edits applied to the
// original content as one write, with `expectedMatches` per edit and a check
// against overlapping edits.
//
// `prepareEdits` is taken from Ahmad-A0/silverbullet-mcp (MIT, src/edit-note.ts,
// v1.2.0), with the error texts kept; see the README, "Attributions".

import { createPatch } from "diff";

export type Edit = { oldText: string; newText: string; expectedMatches: number };

export function prepareEdits(content: string, edits: Edit[]): { content: string; counts: number[] } {
  const ranges: { start: number; end: number; text: string; edit: number }[] = [];
  const counts: number[] = [];
  edits.forEach((edit, index) => {
    const positions: number[] = [];
    for (let start = content.indexOf(edit.oldText); start !== -1; start = content.indexOf(edit.oldText, start + 1)) {
      positions.push(start);
      if (positions.length > edit.expectedMatches) break;
    }
    if (positions.length !== edit.expectedMatches) {
      throw new Error(
        `Edit ${index + 1}: expected ${edit.expectedMatches} exact match(es), found ${positions.length > edit.expectedMatches ? "more than expected" : positions.length}. Nothing was written.`,
      );
    }
    counts.push(positions.length);
    positions.forEach((start) => ranges.push({ start, end: start + edit.oldText.length, text: edit.newText, edit: index + 1 }));
  });
  ranges.sort((a, b) => a.start - b.start);
  for (let i = 1; i < ranges.length; i++) {
    if (ranges[i].start < ranges[i - 1].end) {
      throw new Error(`Edits ${ranges[i - 1].edit} and ${ranges[i].edit} overlap. Nothing was written.`);
    }
  }
  let result = "";
  let offset = 0;
  for (const range of ranges) {
    result += content.slice(offset, range.start) + range.text;
    offset = range.end;
  }
  return { content: result + content.slice(offset), counts };
}

/** A unified diff of the change, truncated to `limit` characters. */
export function diffOf(filename: string, before: string, after: string, limit = 50_000): { diff: string; truncated: boolean } {
  const patch = createPatch(filename, before, after, "", "", { context: 3 });
  return { diff: patch.slice(0, limit), truncated: patch.length > limit };
}
