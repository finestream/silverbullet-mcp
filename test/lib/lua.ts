// Lua snippets the checks send to the Runtime API.

/** A Lua long-bracket string literal that cannot be closed by its content. */
export function luaString(s: string): string {
  let level = 0;
  while (s.includes("]" + "=".repeat(level) + "]")) level++;
  const eq = "=".repeat(level);
  return `[${eq}[\n${s}]${eq}]`; // a leading newline is dropped by Lua
}

/**
 * The render script of the design: expand `${…}`, queries, templates and
 * transclusions of one page, with `_CTX` set by hand (2.12.1 sets none inside
 * markdown.expandMarkdown) and the writing functions of `space` shadowed for
 * the duration of the call (best-effort; see the bypass check).
 */
export function renderScript(page: string): string {
  return `
local name = ${luaString(page)}
local blocked = function() error("rendering is read-only") end
local saved = {}
for _, f in ipairs({"writePage", "deletePage", "writeFile", "deleteFile", "writeDocument", "deleteDocument"}) do
  saved[f] = space[f]
  space[f] = blocked
end
_CTX = {currentPage = index.getObjectByRef(name, "page", name) or space.getPageMeta(name)}
local ok, result = pcall(function() return markdown.expandMarkdown(space.readPage(name)) end)
_CTX = nil
for f, fn in pairs(saved) do space[f] = fn end
if not ok then error(result) end
return result`;
}

/** What the index and the environment hold of the fixtures, after whatever happened before. */
export const STATE_SCRIPT = `return {
  secret = config.get("agentTest.secret"),
  transformStored = config.get({"tags", "space-lua"}) ~= nil,
  outsideRefs = query[[from s = index.tag "space-lua" where not (string.startsWith(s.ref, "CONFIG@") or string.startsWith(s.ref, "Library/")) select s.ref]],
  outsideScripts = query[[from s = index.tag "space-lua" where string.startsWith(s.ref, "Outside@") select s.script]],
  styledStyles = query[[from s = index.tag "space-style" where string.startsWith(s.ref, "Styled@") select s.style]],
  outsideFn = outside_marker and outside_marker() or "nil",
  libFn = mylib_fn and mylib_fn() or "nil",
  outsidePage = #query[[from p = index.tag "page" where p.name == "Outside"]],
}`;

export type State = {
  secret: string | null;
  transformStored: boolean;
  outsideRefs: string[];
  outsideScripts: string[];
  styledStyles: string[];
  outsideFn: string;
  libFn: string;
  outsidePage: number;
};
