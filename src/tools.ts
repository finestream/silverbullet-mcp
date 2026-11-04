// The tool surface (docs/architecture.md, "Tool surface"), registered per
// request for the authenticated user. Every tool resolves the space, checks
// the refuse-to-serve state, then the access list, then calls SilverBullet as
// that user; writes pass the file-type check and the write filter first.
// Tool names and input shapes follow Ahmad-A0/silverbullet-mcp (MIT) so that
// clients written for v1 keep working.

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { AccessList, Right } from "./access.ts";
import { rightsText } from "./access.ts";
import type { Allowlist } from "./filter/allowlist.ts";
import { checkPage, describe, isCodePlace } from "./filter/filter.ts";
import { pageNameOf } from "./access.ts";
import type { Credential } from "./credentials.ts";
import { diffOf, prepareEdits } from "./edit.ts";
import { SbError, SilverBullet, type SbFile } from "./sb.ts";
import type { State } from "./state.ts";
import type { Config } from "./config.ts";
import { NEVER_WRITTEN_TYPES } from "./config.ts";
import type { Log } from "./log.ts";
import { matchAll, MatchTimeout, type MatchItem } from "./match.ts";

export type Context = {
  user: Credential;
  sb: SilverBullet;
  acl: AccessList;
  allow: Allowlist;
  config: Config;
  state: State;
  log: Log;
  cache: Cache;
};

/** A refusal by one of the server's own controls; the message says which. */
export type Control = "access-list" | "write-filter" | "file-type" | "refuse-to-serve" | "revision" | "input";

export class Refusal extends Error {
  readonly control: Control;

  constructor(control: Control, message: string) {
    super(message);
    this.name = "Refusal";
    this.control = control;
  }
}

const LISTING_TTL = 30_000;

/** Listings per (user, space), 30 s; page contents per (user, space, file, lastModified), bounded. Nothing is shared across users. */
export class Cache {
  private listings = new Map<string, { files: SbFile[]; expires: number }>();
  private contents = new Map<string, string>();

  listing(user: string, space: string): SbFile[] | null {
    const e = this.listings.get(`${user}\n${space}`);
    return e && e.expires > Date.now() ? e.files : null;
  }
  setListing(user: string, space: string, files: SbFile[]) {
    this.listings.set(`${user}\n${space}`, { files, expires: Date.now() + LISTING_TTL });
  }
  invalidate(user: string, space: string) {
    this.listings.delete(`${user}\n${space}`);
  }
  content(user: string, space: string, file: string, lastModified: number): string | undefined {
    return this.contents.get(`${user}\n${space}\n${file}\n${lastModified}`);
  }
  setContent(user: string, space: string, file: string, lastModified: number, text: string) {
    if (this.contents.size >= 256) this.contents.delete(this.contents.keys().next().value!);
    this.contents.set(`${user}\n${space}\n${file}\n${lastModified}`, text);
  }
}

const result = (data: Record<string, unknown>, text: string): CallToolResult => ({ content: [{ type: "text", text }], structuredContent: data });
const failure = (text: string): CallToolResult => ({ content: [{ type: "text", text }], isError: true });

const TEXT_TYPES = /^(text\/|application\/(json|yaml|x-yaml|xml|javascript|toml))/;

/** `Agent/Plan` means `Agent/Plan.md`; a name whose last segment has an extension is taken as is. */
export function normalizeName(filename: string): string {
  const name = filename.replace(/^\/+/, "");
  if (name.length === 0 || name.length > 1000) throw new Refusal("input", "The file name is empty or longer than 1000 characters.");
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\\]/.test(name)) throw new Refusal("input", "The file name holds a control character or a backslash.");
  for (const segment of name.split("/")) {
    if (segment === "" || segment === "." || segment === ".." || segment.startsWith(".")) {
      throw new Refusal("input", `The file name "${filename}" has an empty, "." or dot-prefixed segment; SilverBullet refuses those and so does this server.`);
    }
  }
  const last = name.slice(name.lastIndexOf("/") + 1);
  return last.includes(".") ? name : `${name}.md`;
}

const SPACE_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const REGEX_LIMIT = 300;
/** The largest page the server writes, in characters. */
const PAGE_LIMIT = 1_000_000;

/** A user-supplied regex: bounded in length, compiled (to validate) or refused. */
function validRegex(pattern: string, flags: string, what: string): { pattern: string; flags: string } {
  if (pattern.length > REGEX_LIMIT) throw new Refusal("input", `${what} is longer than ${REGEX_LIMIT} characters.`);
  try {
    new RegExp(pattern, flags);
  } catch (e) {
    throw new Refusal("input", `${what} is not a valid regex: ${(e as Error).message}`);
  }
  return { pattern, flags };
}

/** Matches in a worker with a time limit; a pattern that backtracks catastrophically is refused, not served. */
async function matched(re: { pattern: string; flags: string }, items: MatchItem[]) {
  try {
    return await matchAll(re.pattern, re.flags, items);
  } catch (e) {
    if (e instanceof MatchTimeout) throw new Refusal("input", e.message);
    throw e;
  }
}

/** The names of `files` that match a user pattern. */
async function matchingNames(re: { pattern: string; flags: string }, files: SbFile[]): Promise<Set<string>> {
  const results = await matched(re, files.map((f) => ({ id: f.name, text: f.name, lines: false })));
  return new Set(results.filter((r) => r.count > 0).map((r) => r.id));
}

export function registerTools(server: McpServer, ctx: Context) {
  const { user, sb, acl, allow, config, state, log, cache } = ctx;
  const token = user.token;

  const resolveSpace = (space: string | undefined): string => {
    const s = space ?? user.defaultSpace;
    if (!s) throw new Refusal("input", `No space given and user "${user.user}" has no default space; pass the "space" parameter.`);
    if (!SPACE_NAME.test(s)) throw new Refusal("input", `"${s}" is not a space name (letters, digits, "_" and "-").`);
    return s;
  };

  /** The report page is the scan's; nothing writes or deletes it through the tools. */
  const notReportPage = (file: string) => {
    if (pageNameOf(file) === config.reportPage) {
      throw new Refusal("input", `"${config.reportPage}" is the server's report page, written by the scan; it cannot be changed through the tools.`);
    }
  };

  const serving = (space: string) => {
    const refusal = state.refusal(space);
    if (refusal) throw new Refusal("refuse-to-serve", refusal);
  };

  const rightsOn = (space: string, file: string) => acl.rights(user.user, user.groups, space, file);

  const need = (space: string, file: string, ...rights: Right[]) => {
    const have = rightsOn(space, file);
    for (const r of rights) {
      if (!have.has(r)) {
        throw new Refusal("access-list", `Denied by the access list: user "${user.user}" has no "${r}" on ${space}/${pageNameOf(file)} (effective rights: ${rightsText(have)}).`);
      }
    }
  };

  const listing = async (space: string): Promise<SbFile[]> => {
    const cached = cache.listing(user.user, space);
    if (cached) return cached;
    const files = await sb.list(token, space);
    cache.setListing(user.user, space, files);
    return files;
  };

  /** The files of a space the user may read. */
  const visible = async (space: string) => (await listing(space)).filter((f) => rightsOn(space, f.name).has("r"));

  const checkFileType = (file: string) => {
    const lower = file.toLowerCase();
    const never = NEVER_WRITTEN_TYPES.find((t) => lower.endsWith(t));
    if (never) throw new Refusal("file-type", `Refused by the file-type rule: "${never}" files are executed or served as code by SilverBullet and are never written through this server.`);
    if (!config.fileTypes.some((t) => lower.endsWith(t))) {
      throw new Refusal("file-type", `Refused by the file-type rule: "${file}" is not of an allowed type (allowed: ${config.fileTypes.join(", ")}).`);
    }
  };

  /** The write filter on the page that would result (docs/security.md, section 5). */
  const checkContent = (file: string, content: string) => {
    if (!file.toLowerCase().endsWith(".md") || isCodePlace(pageNameOf(file))) return;
    const verdict = checkPage(content, allow);
    if (!verdict.ok) {
      const reasons = verdict.violations.map(describe).join("; ");
      throw new Refusal("write-filter", `Refused by the write filter: the page would hold code (${reasons}). Nothing was written. Pages outside CONFIG and Library/ are data: no code fences, no function definitions or assignments, calls only to allowed functions (docs/security.md, section 5).`);
    }
  };

  const readText = async (space: string, file: string) => {
    const r = await sb.read(token, space, file);
    return { text: r.body.toString("utf8"), etag: r.etag, contentType: r.contentType };
  };

  /** Wraps a handler: refusals and SilverBullet's errors become tool errors; every call is logged. */
  const tool = <A extends Record<string, unknown>>(name: string, fn: (args: A) => Promise<CallToolResult>, spaceOf: (a: A) => string | undefined = (a) => a.space as string | undefined) => {
    return async (args: A): Promise<CallToolResult> => {
      const t0 = performance.now();
      let space: string | null = null;
      try {
        space = spaceOf(args) ?? user.defaultSpace;
      } catch {}
      state.count(state.requests, name);
      state.usersSeen.add(user.user);
      if (space) state.spacesSeen.add(space);
      const done = (outcome: string, detail?: string) => log.request({ user: user.user, space, tool: name, outcome, ms: Math.round(performance.now() - t0), detail });
      try {
        const out = await fn(args);
        done("ok");
        return out;
      } catch (e) {
        if (e instanceof Refusal) {
          state.count(state.refusals, e.control);
          done(`refused:${e.control}`);
          return failure(e.message);
        }
        if (e instanceof SbError) {
          done(`silverbullet:${e.status}`);
          return failure(`SilverBullet refused: ${e.message}`);
        }
        done("error", (e as Error).message);
        return failure(`Error: ${(e as Error).message}`);
      }
    };
  };

  const space = z.string().min(1).optional().describe("Space prefix, for example alpha; default: the user's default space");

  server.registerTool(
    "list-spaces",
    {
      title: "List spaces",
      description: "The spaces this user may reach, with SilverBullet's access level, the access-list entries that apply, and the server's state per space.",
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {},
    },
    tool("list-spaces", async () => {
      const prefixes = new Set<string>(state.spaces.keys());
      if (user.defaultSpace) {
        try {
          for (const p of (await sb.config(token, user.defaultSpace)).spacePrefixes) prefixes.add(p.replace(/^\//, ""));
        } catch {}
      }
      const spaces: Array<Record<string, unknown>> = [];
      for (const s of [...prefixes].sort()) {
        let readOnly: boolean;
        try {
          readOnly = (await sb.config(token, s)).readOnly;
        } catch {
          continue; // not a member, or no such space
        }
        const entries = acl.entriesFor(user.user, user.groups, s).map((e) => ({ subject: e.subject, path: e.path, rights: rightsText(e.rights) }));
        spaces.push({ space: s, silverbullet: readOnly ? "read" : "write", accessList: entries, refusal: state.refusal(s), renderBlocked: state.renderBlock(s) });
      }
      const text = spaces.length
        ? spaces
            .map((s) => `${s.space}: SilverBullet ${s.silverbullet}; access list: ${(s.accessList as Array<{ path: string; rights: string }>).map((e) => `${e.path} ${e.rights}`).join(", ") || "no entries (nothing allowed)"}${s.refusal ? `; NOT SERVED: ${s.refusal}` : ""}${s.renderBlocked ? `; rendering blocked` : ""}`)
            .join("\n")
        : "No space is reachable with this user's token.";
      return result({ user: user.user, defaultSpace: user.defaultSpace, spaces }, text);
    }, () => undefined),
  );

  server.registerTool(
    "list-notes",
    {
      title: "List notes",
      description: "List the files of a space the user may read (pages and other files), with optional name filter and cursor paging.",
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        space,
        namePattern: z.string().optional().describe("JavaScript regex matched against the file name, case-insensitive"),
        limit: z.number().int().min(1).max(500).default(100),
        cursor: z.string().optional().describe("nextCursor of the previous page; keep the filters unchanged"),
      },
    },
    tool("list-notes", async ({ space: sp, namePattern, limit, cursor }) => {
      const s = resolveSpace(sp);
      serving(s);
      let files = await visible(s);
      if (namePattern) {
        const hits = await matchingNames(validRegex(namePattern, "i", "namePattern"), files);
        files = files.filter((f) => hits.has(f.name));
      }
      files.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      const total = files.length;
      let after = "";
      if (cursor !== undefined) {
        after = Buffer.from(cursor, "base64url").toString("utf8");
        if (!after || Buffer.from(after).toString("base64url") !== cursor) throw new Refusal("input", "Invalid cursor.");
      }
      const remaining = files.filter((f) => f.name > after);
      const page = remaining.slice(0, limit);
      const nextCursor = remaining.length > page.length ? Buffer.from(page[page.length - 1].name).toString("base64url") : null;
      const notes = page.map((f) => ({ name: f.name, perm: f.perm, size: f.size, lastModified: f.lastModified, contentType: f.contentType }));
      return result(
        { space: s, notes, total, nextCursor },
        `${s}: ${total} file(s)${namePattern ? ` matching /${namePattern}/i` : ""}\n${notes.map((n) => `- ${n.name} (${n.perm === "rw" ? "read-write" : "read-only"})`).join("\n")}${nextCursor ? `\nNext cursor: ${nextCursor}` : ""}`,
      );
    }),
  );

  server.registerTool(
    "read-note",
    {
      title: "Read note",
      description: "Read a file as stored, with its revision for edit-note. Up to 50,000 characters by default; continue with nextOffset.",
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        space,
        filename: z.string().min(1).describe("Page name or file name; `.md` is added when the name has no extension"),
        offset: z.number().int().min(0).default(0).describe("Character offset (UTF-16 code units)"),
        limit: z.number().int().min(1).max(100_000).default(50_000),
      },
    },
    tool("read-note", async ({ space: sp, filename, offset, limit }) => {
      const s = resolveSpace(sp);
      serving(s);
      const file = normalizeName(filename);
      need(s, file, "r");
      const r = await sb.read(token, s, file);
      const isText = file.endsWith(".md") || TEXT_TYPES.test(r.contentType);
      if (!isText) {
        const data = r.body.toString("base64");
        return result({ space: s, filename: file, revision: r.etag, contentType: r.contentType, encoding: "base64", content: data, totalBytes: r.body.length }, `${file}: ${r.body.length} bytes of ${r.contentType}, base64 in structuredContent.content`);
      }
      const full = r.body.toString("utf8");
      const content = full.slice(offset, offset + limit);
      const nextOffset = offset + content.length < full.length ? offset + content.length : null;
      return result({ space: s, filename: file, content, revision: r.etag, offset, totalCharacters: full.length, nextOffset }, content + (nextOffset !== null ? `\n[Truncated; continue with offset=${nextOffset}]` : ""));
    }),
  );

  server.registerTool(
    "read-multiple-notes",
    {
      title: "Read multiple notes",
      description: "Read several pages at once, by name or by a name pattern.",
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        space,
        filenames: z.array(z.string().min(1)).min(1).max(100).optional(),
        namePattern: z.string().optional().describe("JavaScript regex over file names, case-insensitive"),
        maxResults: z.number().int().min(1).max(100).default(50),
        contentLimit: z.number().int().min(1).max(100_000).default(50_000).describe("Maximum characters per note"),
      },
    },
    tool("read-multiple-notes", async ({ space: sp, filenames, namePattern, maxResults, contentLimit }) => {
      const s = resolveSpace(sp);
      serving(s);
      if (!filenames && !namePattern) throw new Refusal("input", "Give filenames or a namePattern.");
      const names = new Set<string>((filenames ?? []).map(normalizeName));
      if (namePattern) {
        for (const name of await matchingNames(validRegex(namePattern, "i", "namePattern"), await visible(s))) names.add(name);
      }
      const notes: Array<Record<string, unknown>> = [];
      for (const file of [...names].slice(0, maxResults)) {
        try {
          need(s, file, "r");
          const r = await readText(s, file);
          notes.push({ filename: file, revision: r.etag, content: r.text.slice(0, contentLimit), truncated: r.text.length > contentLimit, totalCharacters: r.text.length });
        } catch (e) {
          notes.push({ filename: file, error: e instanceof SbError ? `SilverBullet refused: ${e.message}` : (e as Error).message });
        }
      }
      const text = notes.map((n) => (n.error ? `## ${n.filename}\nError: ${n.error}` : `## ${n.filename}\n${n.content}${n.truncated ? "\n[Truncated; use read-note to continue]" : ""}`)).join("\n\n---\n\n");
      return result({ space: s, notes, total: notes.length, errors: notes.filter((n) => n.error).length }, text || "No notes matched.");
    }),
  );

  server.registerTool(
    "search-notes",
    {
      title: "Search notes",
      description: "Full-text search over the pages the user may read, with paging.",
      annotations: { readOnlyHint: true, openWorldHint: false },
      inputSchema: {
        space,
        query: z.string().min(1).describe("Text or JavaScript regex"),
        useRegex: z.boolean().default(true),
        caseSensitive: z.boolean().default(false),
        searchType: z.enum(["content", "title", "both"]).default("both"),
        maxResults: z.number().int().min(1).max(100).default(10).describe("Notes per page"),
        page: z.number().int().min(1).default(1),
        contextLines: z.number().int().min(0).max(20).default(1),
        maxMatchesPerNote: z.number().int().min(1).max(100).default(20),
      },
    },
    tool("search-notes", async ({ space: sp, query, useRegex, caseSensitive, searchType, maxResults, page, contextLines, maxMatchesPerNote }) => {
      const s = resolveSpace(sp);
      serving(s);
      const re = validRegex(useRegex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), caseSensitive ? "g" : "gi", "query");
      const pages = (await visible(s)).filter((f) => f.name.endsWith(".md"));
      type Match = { type: "title" | "content"; line: number; content: string; matchCount: number; context?: string };
      const hits: Array<{ filename: string; matches: Match[]; score: number }> = [];
      const errors: Array<{ filename: string; message: string }> = [];
      // Fetch the contents on this thread, match everything in the worker, then build the results.
      const texts = new Map<string, string>();
      const items: MatchItem[] = [];
      for (const f of pages) {
        if (searchType !== "content") items.push({ id: `title\n${f.name}`, text: f.name, lines: false });
        if (searchType !== "title") {
          try {
            let text = cache.content(user.user, s, f.name, f.lastModified);
            if (text === undefined) {
              text = (await readText(s, f.name)).text;
              cache.setContent(user.user, s, f.name, f.lastModified, text);
            }
            texts.set(f.name, text);
            items.push({ id: `content\n${f.name}`, text, lines: true });
          } catch (e) {
            errors.push({ filename: f.name, message: (e as Error).message });
          }
        }
      }
      const found = new Map((await matched(re, items)).map((r) => [r.id, r]));
      for (const f of pages) {
        const matches: Match[] = [];
        const title = found.get(`title\n${f.name}`);
        if (title && title.count > 0) matches.push({ type: "title", line: 0, content: f.name, matchCount: title.count });
        const content = found.get(`content\n${f.name}`);
        if (content && content.lines) {
          const lines = texts.get(f.name)!.split("\n");
          for (const [i, n] of content.lines) {
            const from = Math.max(0, i - contextLines);
            const to = Math.min(lines.length - 1, i + contextLines);
            matches.push({ type: "content", line: i + 1, content: lines[i].trim().slice(0, 2000), matchCount: n, context: contextLines > 0 ? lines.slice(from, to + 1).join("\n").slice(0, 4000) : undefined });
          }
        }
        if (matches.length) hits.push({ filename: f.name, matches, score: matches.reduce((a, m) => a + m.matchCount, 0) });
      }
      hits.sort((a, b) => b.score - a.score);
      const totalResults = hits.length;
      const totalPages = Math.max(1, Math.ceil(totalResults / maxResults));
      const start = (page - 1) * maxResults;
      const results = hits.slice(start, start + maxResults).map((h) => ({ ...h, matchesTruncated: h.matches.length > maxMatchesPerNote, matches: h.matches.slice(0, maxMatchesPerNote) }));
      const text = totalResults === 0
        ? `No matches for "${query}" in ${s}.`
        : `SEARCH "${query}" in ${s}: ${totalResults} note(s) | page ${page}/${totalPages}\n\n` +
          results.map((r, i) => `${start + i + 1}. ${r.filename} (${r.score}x)\n` + r.matches.slice(0, 3).map((m) => (m.type === "title" ? "  • title match" : `  • L${m.line}: ${m.content.slice(0, 100)}`)).join("\n") + (r.matches.length > 3 ? `\n  • … ${r.matches.length - 3} more` : "")).join("\n") +
          (errors.length ? `\n\nWarning: ${errors.length} note(s) could not be read.` : "");
      return result({ space: s, query, results, totalResults, page, totalPages, nextPage: page < totalPages ? page + 1 : null, errors }, text);
    }),
  );

  server.registerTool(
    "create-note",
    {
      title: "Create note",
      description: "Create a page (or, where allowed, another file). Pages outside CONFIG and Library/ must hold no code: the write filter refuses them otherwise.",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      inputSchema: {
        space,
        filename: z.string().min(1).describe("Page name or file name; `.md` is added when the name has no extension"),
        content: z.string().max(PAGE_LIMIT),
        encoding: z.enum(["utf8", "base64"]).default("utf8").describe("base64 for binary files"),
        overwrite: z.boolean().default(false).describe("Replace an existing file; prefer edit-note for pages"),
      },
    },
    tool("create-note", async ({ space: sp, filename, content, encoding, overwrite }) => {
      const s = resolveSpace(sp);
      serving(s);
      const file = normalizeName(filename);
      notReportPage(file);
      need(s, file, "w");
      checkFileType(file);
      const body = encoding === "base64" ? Buffer.from(content, "base64") : content;
      if (typeof body === "string") checkContent(file, body);
      const r = await sb.write(token, s, file, body, overwrite ? {} : { ifNoneMatch: "*" }).catch((e) => {
        if (e instanceof SbError && e.status === 412 && !overwrite) throw new Refusal("revision", `${file} already exists in ${s}. Use edit-note, or overwrite=true.`);
        throw e;
      });
      cache.invalidate(user.user, s);
      state.dropFindings(s, pageNameOf(file));
      return result({ space: s, filename: file, revision: r.etag, overwrite }, `Created ${s}/${file} (revision ${r.etag})`);
    }),
  );

  server.registerTool(
    "edit-note",
    {
      title: "Edit note",
      description: "Apply exact, case-sensitive edits to a page as one conditional write. expectedRevision is the revision read-note returned; a stale revision is rejected. dryRun returns the diff without writing.",
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      inputSchema: {
        space,
        filename: z.string().min(1),
        edits: z
          .array(
            z
              .object({
                oldText: z.string().min(1).max(100_000).describe("Exact, case-sensitive text in the original"),
                newText: z.string().max(100_000).describe("Literal replacement"),
                expectedMatches: z.number().int().min(1).max(10_000).default(1),
              })
              .strict(),
          )
          .min(1)
          .max(100)
          .describe("Non-overlapping edits, all matched against the original content"),
        expectedRevision: z.string().min(1).describe("The revision returned by read-note or a previous dry run"),
        dryRun: z.boolean().default(false),
      },
    },
    tool("edit-note", async ({ space: sp, filename, edits, expectedRevision, dryRun }) => {
      const s = resolveSpace(sp);
      serving(s);
      const file = normalizeName(filename);
      notReportPage(file);
      need(s, file, "r", "w");
      checkFileType(file);
      const original = await readText(s, file);
      if (original.etag !== expectedRevision) {
        throw new Refusal("revision", `Revision conflict: ${file} is at ${original.etag}, not ${expectedRevision}. Read it again before editing. Nothing was written.`);
      }
      let prepared: { content: string; counts: number[] };
      try {
        prepared = prepareEdits(original.text, edits);
      } catch (e) {
        throw new Refusal("input", (e as Error).message);
      }
      const changed = prepared.content !== original.text;
      if (prepared.content.length > PAGE_LIMIT) throw new Refusal("input", `The page would be longer than ${PAGE_LIMIT} characters. Nothing was written.`);
      if (changed) checkContent(file, prepared.content);
      const { diff, truncated } = diffOf(file, original.text, prepared.content);
      let revision: string | null = original.etag;
      if (!dryRun && changed) {
        if (!original.etag || original.etag.startsWith("W/")) throw new Refusal("revision", "SilverBullet returned no strong revision; conditional editing is unavailable. Nothing was written.");
        const w = await sb.write(token, s, file, prepared.content, { ifMatch: original.etag }).catch((e) => {
          if (e instanceof SbError && e.status === 412) throw new Refusal("revision", `Revision conflict: ${file} changed while editing. Read it again. Nothing was written.`);
          throw e;
        });
        revision = w.etag;
        cache.invalidate(user.user, s);
        state.dropFindings(s, pageNameOf(file));
      }
      const data = { space: s, filename: file, dryRun, changed, applied: !dryRun && changed, replacements: prepared.counts, previousRevision: original.etag, revision, diff, diffTruncated: truncated };
      return result(data, `${dryRun ? "Preview" : changed ? "Edited" : "Unchanged"}: ${s}/${file}${!dryRun && changed ? ` (revision ${revision})` : ""}\n${diff}${truncated ? "\n[Diff truncated]" : ""}`);
    }),
  );

  server.registerTool(
    "delete-note",
    {
      title: "Delete note",
      description: "Delete a file. Needs the d right; with expectedRevision the delete is conditional.",
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
      inputSchema: {
        space,
        filename: z.string().min(1),
        expectedRevision: z.string().min(1).optional(),
      },
    },
    tool("delete-note", async ({ space: sp, filename, expectedRevision }) => {
      const s = resolveSpace(sp);
      serving(s);
      const file = normalizeName(filename);
      notReportPage(file);
      need(s, file, "d");
      await sb.delete(token, s, file, expectedRevision ? { ifMatch: expectedRevision } : {}).catch((e) => {
        if (e instanceof SbError && e.status === 412) throw new Refusal("revision", `Revision conflict: ${file} is not at ${expectedRevision}. Read it again. Nothing was deleted.`);
        throw e;
      });
      cache.invalidate(user.user, s);
      state.dropFindings(s, pageNameOf(file), file);
      return result({ space: s, filename: file, deleted: true }, `Deleted ${s}/${file}`);
    }),
  );
}
