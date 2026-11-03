import test from "node:test";
import assert from "node:assert/strict";
import { diffOf, prepareEdits } from "./edit.ts";

test("edit: edits apply in document order whatever their order in the request", () => {
  const r = prepareEdits("one two three", [
    { oldText: "three", newText: "3", expectedMatches: 1 },
    { oldText: "one", newText: "1", expectedMatches: 1 },
  ]);
  assert.equal(r.content, "1 two 3");
  assert.deepEqual(r.counts, [1, 1]);
});

test("edit: expectedMatches must equal the number of occurrences", () => {
  assert.throws(() => prepareEdits("a a a", [{ oldText: "a", newText: "b", expectedMatches: 1 }]), /expected 1 exact match\(es\), found more than expected/);
  assert.throws(() => prepareEdits("a a a", [{ oldText: "a", newText: "b", expectedMatches: 4 }]), /found 3/);
  assert.throws(() => prepareEdits("a", [{ oldText: "z", newText: "b", expectedMatches: 1 }]), /found 0/);
  assert.equal(prepareEdits("a a a", [{ oldText: "a", newText: "b", expectedMatches: 3 }]).content, "b b b");
});

test("edit: overlapping edits are refused without writing", () => {
  assert.throws(
    () => prepareEdits("abcdef", [{ oldText: "abc", newText: "x", expectedMatches: 1 }, { oldText: "cde", newText: "y", expectedMatches: 1 }]),
    /Edits 1 and 2 overlap/,
  );
  // Adjacent edits do not overlap.
  assert.equal(prepareEdits("abcdef", [{ oldText: "abc", newText: "x", expectedMatches: 1 }, { oldText: "def", newText: "y", expectedMatches: 1 }]).content, "xy");
});

test("edit: CRLF content is matched and preserved byte for byte", () => {
  const content = "line one\r\nline two\r\n";
  assert.throws(() => prepareEdits(content, [{ oldText: "one\ntwo", newText: "x", expectedMatches: 1 }]), /found 0/);
  const r = prepareEdits(content, [{ oldText: "one\r\nline", newText: "1\r\nLINE", expectedMatches: 1 }]);
  assert.equal(r.content, "line 1\r\nLINE two\r\n");
});

test("edit: unicode beyond the basic plane and combining marks are matched exactly", () => {
  const content = "Plan 🚀 für Zürich: café ☕ and é";
  const r = prepareEdits(content, [
    { oldText: "🚀", newText: "✈️", expectedMatches: 1 },
    { oldText: "é", newText: "é", expectedMatches: 1 },
  ]);
  assert.equal(r.content, "Plan ✈️ für Zürich: café ☕ and é");
  assert.throws(() => prepareEdits(content, [{ oldText: "é", newText: "e", expectedMatches: 2 }]), /found 1/, "a precomposed é does not match e + combining acute");
});

test("edit: an empty replacement deletes; the diff names the file", () => {
  const r = prepareEdits("keep drop keep", [{ oldText: " drop", newText: "", expectedMatches: 1 }]);
  assert.equal(r.content, "keep keep");
  const { diff, truncated } = diffOf("Note.md", "keep drop keep", r.content);
  assert.match(diff, /^Index: Note.md/);
  assert.match(diff, /-keep drop keep/);
  assert.equal(truncated, false);
});
