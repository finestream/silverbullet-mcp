// The allowlist of the write filter (docs/security.md, section 6): the
// functions and values a page outside CONFIG and Library/ may reference. A
// configuration file of the server, validated at start against the names that
// are never allowed, whatever the file says.

/** The entries the server ships with. Every one of them only reads. */
export const SHIPPED_ALLOWLIST: readonly string[] = [
  "query",
  "template.each",
  "templates.*",
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
 * that function only. The only way through is an exact entry naming a member
 * of REVIEWED_MEMBERS. Reviewed against SilverBullet 2.12.1 (docs/security.md,
 * section 6, holds the reason per member).
 */
export const NEVER_ALLOWED: readonly string[] = [
  // Lua loaders and reflection
  "load", "loadstring", "dofile", "require", "_G",
  "rawget", "rawset", "rawequal", "rawlen", "getmetatable", "setmetatable",
  "os", "io", "debug", "package",
  // SilverBullet namespaces that read or write beyond the page, or reach outside
  "space", "config", "net", "http", "sandboxFetch", "shell", "js", "system", "editor", "datastore", "clientStore",
  "event", "sync", "dom", "mq", "asset", "widget", "codeWidget", "spacelua", "lua", "service", "capture", "view", "navigator",
  "github", "share", "journal.openOrCreate", "embed",
  // registries that store Lua callbacks in the client's configuration
  "tag", "command", "slashCommand", "slashcommand", "schema", "aggregate", "actionButton", "keyboardBar",
  "syntax", "taskState", "virtualPage", "identity.define", "toggleReadOnlyMode",
  // functions that evaluate their input, or read a page named by it and evaluate that
  "template.new", "template.fromPage", "template.createPageFromTemplate", "markdown",
  // index functions that write the index or a page, register a tag, or evaluate a query given as data
  "index.indexObjects", "index.deleteObject", "index.defineTag", "index.patchFrontmatter",
  "index.reindexSpace", "index.ensureFullIndex", "index.clearFileIndex",
  // takes a query as a table whose clauses are Lua syntax trees: code as data
  "index.queryLuaObjects",
];

/**
 * Members of never-allowed namespaces that only read the clock, build a plain table or
 * report a fact about the client, reviewed one by one against SilverBullet 2.12.1
 * (docs/security.md, section 6). An exact allowlist entry naming one of them is valid;
 * a wildcard under the namespace, or a member not listed here, is not. The release
 * checks (test/checks) assert that each still exists and behaves as reviewed.
 */
export const REVIEWED_MEMBERS: readonly string[] = [
  // os: the clock, nothing else exists in Space Lua
  "os.date", "os.time", "os.difftime", "os.clock",
  // schema: constructors that return a plain table
  "schema.string", "schema.number", "schema.boolean", "schema.array", "schema.nullable", "schema.nullableArray",
  "schema.func", "schema.schema", "schema.object", "schema.null",
  // markdown: parse and print, without expansion
  "markdown.parseMarkdown", "markdown.renderParseTree",
  // system and editor: facts about the client
  "system.getVersion", "system.getMode", "system.getBaseURI", "system.getURLPrefix",
  "editor.getCurrentPage", "editor.getCurrentPageMeta", "editor.getCurrentPath", "editor.isMobile", "editor.isNarrowScreen",
  // spacelua: the base URL of the client
  "spacelua.baseUrl",
];

const REVIEWED = new Set(REVIEWED_MEMBERS);

/** Whether a static dotted path is a never-allowed name or lies under one. */
export function isNeverAllowed(joined: string): boolean {
  return NEVER_ALLOWED.some((n) => joined === n || joined.startsWith(n + "."));
}

/** Whether a static dotted path is a reviewed member (allowable by an exact allowlist entry). */
export const isReviewedMember = (joined: string) => REVIEWED.has(joined);

export type Allowlist = {
  entries: string[];
  /** Whether a static dotted path (`template.each`, `string.find`, `templates`) is allowed. */
  allows(path: string[]): boolean;
  /** Whether a never-allowed path is admitted as a reviewed member by an exact entry (`os.date`). */
  excepts(path: string[]): boolean;
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
 * never-allowed names. An exact entry under a never-allowed name is valid only when it is
 * a reviewed member. Returns the problems; an empty list means the allowlist is valid.
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
    if (isExact(entry) && isNeverAllowed(entry)) {
      if (REVIEWED.has(entry)) continue;
      const never = NEVER_ALLOWED.find((n) => entry === n || entry.startsWith(n + "."))!;
      problems.push(
        never === entry
          ? `"${entry}" is a never-allowed name`
          : `"${entry}" is under the never-allowed name "${never}" and is not a reviewed member (docs/security.md, section 6)`,
      );
      continue;
    }
    for (const never of NEVER_ALLOWED) {
      if (covers(entry, never)) problems.push(`"${entry}" covers the never-allowed name "${never}"`);
    }
  }
  return problems;
}

/** An entry without a wildcard: `name` or `name.sub`. */
const isExact = (entry: string) => !entry.startsWith("*.") && !entry.endsWith(".*");

/** Whether a wildcard entry would admit a never-allowed name. */
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
  const exceptions = new Set<string>();
  for (const e of entries) {
    if (e.startsWith("*.")) methods.add(e.slice(2));
    else if (e.endsWith(".*")) prefixes.push(e.slice(0, -2));
    else {
      exact.add(e);
      if (REVIEWED.has(e) && isNeverAllowed(e)) exceptions.add(e);
    }
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
    excepts(path: string[]): boolean {
      return exceptions.has(path.join("."));
    },
  };
}

export const shippedAllowlist = () => compileAllowlist(SHIPPED_ALLOWLIST);
