import test from "node:test";
import assert from "node:assert/strict";
import { compileAccessList, parseAccessList, rightsText } from "./access.ts";

const LIST = `
# user-or-group  space    path            rights
@agents          notes    /               r
@agents          notes    CONFIG          -
@agents          notes    SETTINGS        -
@agents          notes    Library/        -
@agents          notes    Shared/         rw
writer-bot       notes    Shared/Bot/     rwdx
writer-bot       notes    Shared/         rwx
@ops             notes    Shared/         -
@readers         *        Public/         r
alice            notes    ZZ Agent internal/Claude code/  rwd
`;

const { entries, problems } = parseAccessList(LIST);
const acl = compileAccessList(entries);
const rights = (user: string, groups: string[], space: string, file: string) => rightsText(acl.rights(user, groups, space, file));

test("access: the file parses, with page names that contain spaces", () => {
  assert.deepEqual(problems, []);
  assert.equal(entries.length, 10);
  assert.equal(entries[9].path, "ZZ Agent internal/Claude code/");
});

test("access: deny by default", () => {
  assert.equal(rights("nobody", [], "notes", "Shared/x.md"), "-");
  assert.equal(rights("writer-bot", ["agents"], "other", "Shared/x.md"), "-");
});

test("access: the shipped example of the security model", () => {
  assert.equal(rights("writer-bot", ["agents"], "notes", "index.md"), "r");
  assert.equal(rights("writer-bot", ["agents"], "notes", "CONFIG.md"), "-");
  assert.equal(rights("writer-bot", ["agents"], "notes", "Library/Std/Config.md"), "-");
  assert.equal(rights("writer-bot", ["agents"], "notes", "Shared/Note.md"), "rwx", "the user entry wins on the same path");
  assert.equal(rights("writer-bot", ["agents"], "notes", "Shared/Bot/Note.md"), "rwdx", "the most specific path replaces the others");
  assert.equal(rights("other-bot", ["agents"], "notes", "Shared/Note.md"), "rw");
  assert.equal(rights("other-bot", ["agents"], "notes", "Shared/Bot/Note.md"), "rw", "a folder entry covers its subfolders");
});

test("access: between groups on the same path `-` wins, otherwise rights add up", () => {
  assert.equal(rights("x", ["agents", "ops"], "notes", "Shared/Note.md"), "-");
  assert.equal(rights("x", ["agents", "readers"], "notes", "Public/P.md"), "r");
  const { entries: e2 } = parseAccessList("@a notes Shared/ r\n@b notes Shared/ w\n");
  assert.equal(rightsText(compileAccessList(e2).rights("x", ["a", "b"], "notes", "Shared/N.md")), "rw");
});

test("access: an exact page entry matches that page only; `*` matches every space", () => {
  assert.equal(rights("x", ["agents"], "notes", "CONFIG.md"), "-");
  assert.equal(rights("x", ["agents"], "notes", "CONFIG/sub.md"), "r", "a folder with the same name is not the page");
  assert.equal(rights("x", ["readers"], "anything", "Public/P.md"), "r");
  assert.equal(rights("alice", [], "notes", "ZZ Agent internal/Claude code/Plan.md"), "rwd");
  assert.equal(rights("alice", [], "notes", "ZZ Agent internal/shared.md"), "-");
});

test("access: non-page files are matched by their file name", () => {
  const { entries: e } = parseAccessList("bot notes Pictures/ r\nbot notes report.csv rw\n");
  const a = compileAccessList(e);
  assert.equal(rightsText(a.rights("bot", [], "notes", "Pictures/a.png")), "r");
  assert.equal(rightsText(a.rights("bot", [], "notes", "report.csv")), "rw");
  assert.equal(rightsText(a.rights("bot", [], "notes", "report.md")), "-");
});

test("access: malformed lines are reported and skipped", () => {
  const { entries: e, problems: p } = parseAccessList("bot notes /\nbot notes / q\nbot notes / r\n");
  assert.equal(e.length, 1);
  assert.equal(p.length, 2);
});
