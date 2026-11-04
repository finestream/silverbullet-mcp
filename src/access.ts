// The access list (docs/security.md, section 4): per user or group, space and
// path, what an agent may do through this server. Deny by default; the most
// specific path wins; on the same path a user entry wins over group entries;
// between groups `-` wins, otherwise rights add up.

export type Right = "r" | "w" | "d" | "x";
export type Rights = Set<Right>;

export type AccessEntry = {
  /** `alice` or `@agents`. */
  subject: string;
  /** A space prefix, or `*` for every space. */
  space: string;
  /** `/` for the whole space, an exact page name, or a folder ending in `/`. */
  path: string;
  /** The rights, empty for `-`. */
  rights: Rights;
  deny: boolean;
  line: number;
};

export type AccessList = {
  entries: AccessEntry[];
  /** The rights of a user on one page or file of a space. */
  rights(user: string, groups: readonly string[], space: string, path: string): Rights;
  /** The entries that apply to the user in a space, for `list-spaces`. */
  entriesFor(user: string, groups: readonly string[], space: string): AccessEntry[];
};

export const NO_RIGHTS: Rights = new Set();

const RIGHTS = /^[rwdx]+$/;

/**
 * Parses the file: `subject space path rights`, whitespace-separated, `#` comments. A page name
 * may contain single spaces: the path is everything between the space and the rights.
 */
export function parseAccessList(text: string): { entries: AccessEntry[]; problems: string[] } {
  const entries: AccessEntry[] = [];
  const problems: string[] = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) return;
    const tokens = line.split(/\s+/);
    if (tokens.length < 4) {
      problems.push(`line ${i + 1}: expected "user-or-group space path rights", got "${line}"`);
      return;
    }
    const subject = tokens[0];
    const space = tokens[1];
    const rightsText = tokens[tokens.length - 1];
    const path = tokens.slice(2, -1).join(" ");
    if (rightsText !== "-" && !RIGHTS.test(rightsText)) {
      problems.push(`line ${i + 1}: rights must be letters of "rwdx" or "-", got "${rightsText}"`);
      return;
    }
    entries.push({
      subject,
      space,
      path,
      rights: new Set(rightsText === "-" ? [] : (rightsText.split("") as Right[])),
      deny: rightsText === "-",
      line: i + 1,
    });
  });
  return { entries, problems };
}

/** The page name the list is matched against: the file name without `.md` for pages, the file name otherwise. */
export function pageNameOf(file: string): string {
  return file.endsWith(".md") ? file.slice(0, -3) : file;
}

/** Whether an entry's path covers a page name. */
export function pathMatches(entryPath: string, page: string): boolean {
  if (entryPath === "/") return true;
  if (entryPath.endsWith("/")) return page.startsWith(entryPath);
  return page === entryPath;
}

/** A longer path is more specific; the whole space is the least specific. */
function specificity(entryPath: string): number {
  return entryPath === "/" ? 0 : entryPath.length;
}

export function compileAccessList(entries: AccessEntry[]): AccessList {
  const applicable = (user: string, groups: readonly string[], space: string) => {
    const subjects = new Set([user, ...groups.map((g) => `@${g}`)]);
    return entries.filter((e) => subjects.has(e.subject) && (e.space === space || e.space === "*"));
  };
  return {
    entries,
    rights(user, groups, space, file) {
      const page = pageNameOf(file);
      const matching = applicable(user, groups, space).filter((e) => pathMatches(e.path, page));
      if (matching.length === 0) return NO_RIGHTS;
      const best = Math.max(...matching.map((e) => specificity(e.path)));
      const atBest = matching.filter((e) => specificity(e.path) === best);
      const own = atBest.filter((e) => !e.subject.startsWith("@"));
      const chosen = own.length > 0 ? own : atBest;
      if (chosen.some((e) => e.deny)) return NO_RIGHTS;
      const out: Rights = new Set();
      for (const e of chosen) for (const r of e.rights) out.add(r);
      return out;
    },
    entriesFor(user, groups, space) {
      return applicable(user, groups, space);
    },
  };
}

export const rightsText = (rights: Rights) => (rights.size === 0 ? "-" : (["r", "w", "d", "x"] as const).filter((r) => rights.has(r)).join(""));
