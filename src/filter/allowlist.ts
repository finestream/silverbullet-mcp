// The allowlist of the write filter (docs/security.md, section 6): the
// functions and values a page outside CONFIG and Library/ may reference. A
// configuration file of the server, validated at start against the names that
// are never allowed, whatever the file says.

/** The entries the server ships with. Every one of them only reads. */
export const SHIPPED_ALLOWLIST: readonly string[] = [
  "query",
  "template.each",
  "templates.*",
  "views.*",
  "string.*",
  // The index functions that read. The ones that write the index or a page, or
  // register a tag, are never allowed (see below).
  "index.aggregates",
  "index.aspiringPages",
  "index.contentPages",
  "index.describeSchema",
  "index.documents",
  "index.extractFrontmatter",
  "index.getObjectByRef",
  "index.headers",
  "index.isAvailable",
  "index.items",
  "index.links",
  "index.metaPages",
  "index.objects",
  "index.pages",
  "index.paragraphs",
  "index.relations",
  "index.resolveAnchor",
  "index.subPages",
  "index.tables",
  "index.tag",
  "index.tagSchema",
  "index.tags",
  "index.tasks",
];

/**
 * Names that are never allowed: the loaders, the metatable functions, the
 * namespaces that read or write beyond the page, the registries that take Lua
 * callbacks, and the functions that evaluate their input. A bare name covers
 * everything under it (`space` covers `space.readPage`); a dotted name covers
 * that function only.
 */
export const NEVER_ALLOWED: readonly string[] = [
  // Lua loaders and reflection
  "load", "loadstring", "dofile", "require", "_G",
  "rawget", "rawset", "rawequal", "rawlen", "getmetatable", "setmetatable",
  "os", "io", "debug", "package",
  // SilverBullet namespaces that read or write beyond the page, or reach outside
  "space", "config", "net", "shell", "js", "system", "editor", "datastore", "clientStore",
  "event", "sync", "dom", "mq", "asset", "widget", "codeWidget", "spacelua",
  // registries that store Lua callbacks in the client's configuration
  "tag", "command", "schema",
  // functions that evaluate their input
  "template.new", "markdown",
  // index functions that write the index or a page, register a tag, or evaluate a query given as data
  "index.indexObjects", "index.deleteObject", "index.defineTag", "index.patchFrontmatter",
  "index.reindexSpace", "index.ensureFullIndex", "index.clearFileIndex",
  // takes a query as a table whose clauses are Lua syntax trees: code as data
  "index.queryLuaObjects",
];

export type Allowlist = {
  entries: string[];
  /** Whether a static dotted path (`template.each`, `string.find`, `templates`) is allowed. */
  allows(path: string[]): boolean;
};

/** Parses the allowlist file: one entry per line, `#` starts a comment, blank lines ignored. */
export function parseAllowlist(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/#.*$/, "").trim())
    .filter((line) => line.length > 0);
}

const ENTRY = /^(\*\.[A-Za-z_][A-Za-z0-9_]*|[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*(\.\*)?)$/;

/**
 * Validates entries against the format (`name`, `name.sub`, `name.*`, `*.method`) and the
 * never-allowed names. Returns the problems; an empty list means the allowlist is valid.
 */
export function validateAllowlist(entries: readonly string[]): string[] {
  const problems: string[] = [];
  for (const entry of entries) {
    if (entry === "*" || entry === "*.*") {
      problems.push(`"${entry}" would allow everything`);
      continue;
    }
    if (!ENTRY.test(entry)) {
      problems.push(`"${entry}" is not a name, a dotted name, "name.*" or "*.method"`);
      continue;
    }
    for (const never of NEVER_ALLOWED) {
      if (covers(entry, never)) problems.push(`"${entry}" covers the never-allowed name "${never}"`);
    }
  }
  return problems;
}

/** Whether an allowlist entry would admit a never-allowed name. */
function covers(entry: string, never: string): boolean {
  if (entry.startsWith("*.")) {
    // `*.method` admits `obj.method` for every obj, so it covers `template.new` for method `new`.
    const method = entry.slice(2);
    return never.includes(".") ? never.endsWith("." + method) : false;
  }
  if (entry.endsWith(".*")) {
    const prefix = entry.slice(0, -2);
    return never === prefix || never.startsWith(prefix + ".") || prefix.startsWith(never + ".");
  }
  return entry === never || entry.startsWith(never + ".");
}

export function compileAllowlist(entries: readonly string[]): Allowlist {
  const exact = new Set<string>();
  const prefixes: string[] = [];
  const methods = new Set<string>();
  for (const e of entries) {
    if (e.startsWith("*.")) methods.add(e.slice(2));
    else if (e.endsWith(".*")) prefixes.push(e.slice(0, -2));
    else exact.add(e);
  }
  return {
    entries: [...entries],
    allows(path: string[]): boolean {
      const joined = path.join(".");
      if (exact.has(joined)) return true;
      // An exact entry also admits a reference to a prefix of it only when the entry is the
      // whole path (`templates.pageItem` admits nothing else); a `name.*` entry admits the
      // name itself and everything under it.
      if (prefixes.some((p) => joined === p || joined.startsWith(p + "."))) return true;
      if (path.length >= 2 && methods.has(path[path.length - 1])) return true;
      return false;
    },
  };
}

export const shippedAllowlist = () => compileAllowlist(SHIPPED_ALLOWLIST);
