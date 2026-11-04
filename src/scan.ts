// The scan (docs/security.md, sections 7 and 8) and the transform check
// (section 10), as the technical user `scan`: which spaces are guarded,
// whether CONFIG holds the shipped transform block, which pages outside
// CONFIG and Library/ hold code, which files are not pages; the report page
// per space; the quarantine when the operator chose it.

import { checkPage, isCodePlace, type Violation } from "./filter/filter.ts";
import { compileAllowlist, type Allowlist } from "./filter/allowlist.ts";
import { pageNameOf, pathMatches } from "./access.ts";
import { SbError, type SilverBullet, type SbFile } from "./sb.ts";
import type { Config } from "./config.ts";
import type { State, SpaceState, Finding, FileFinding } from "./state.ts";
import type { Log } from "./log.ts";
import { parser as mdParser } from "@lezer/markdown";

/** The index-time transform block, verbatim as in docs/security.md, section 10. The checks in test/ assert that. */
export const SHIPPED_TRANSFORM = `-- Shipped with the MCP server. Keep verbatim; the server checks for it at start.
local function confine(o)
  local page = string.match(o.ref, "^(.*)@%d+$") or ""
  if page == "CONFIG" or string.startsWith(page, "Library/") then return o end
  if o.script then o.script = "-- not loaded: outside CONFIG and Library/" end
  if o.style then o.style = "/* not loaded: outside CONFIG and Library/ */" end
  return o
end
tag.define { name = "space-lua", transform = confine }
tag.define { name = "space-style", transform = confine }`;

/** Whether a CONFIG page holds the shipped block, verbatim, inside a space-lua fence. */
export function hasTransform(configSource: string): boolean {
  const src = configSource.replace(/\r\n/g, "\n");
  const tree = mdParser.parse(src);
  let found = false;
  tree.iterate({
    enter(n) {
      if (found || n.name !== "FencedCode") return;
      const info = n.node.getChild("CodeInfo");
      const lang = info ? src.slice(info.from, info.to).trim().split(/\s+/)[0] : "";
      if (lang !== "space-lua") return;
      const body = src.slice(n.from, n.to);
      if (body.includes(SHIPPED_TRANSFORM)) found = true;
    },
  });
  return found;
}

export type AllowedFile = { space: string; path: string };

/** The allowed-files list: `space path` per line, `*` for every space; a path is a file or a folder ending in `/`. */
export function parseAllowedFiles(text: string): { value: AllowedFile[]; problems: string[] } {
  const value: AllowedFile[] = [];
  const problems: string[] = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) return;
    const sp = line.indexOf(" ");
    if (sp === -1) {
      problems.push(`line ${i + 1}: expected "space path"`);
      return;
    }
    value.push({ space: line.slice(0, sp), path: line.slice(sp + 1).trim() });
  });
  return { value, problems };
}

export type ScanDeps = {
  sb: SilverBullet;
  state: State;
  config: Config;
  log: Log;
  scanToken: () => string | null;
  /** The spaces to start discovery from: every default space of the credentials file. */
  seedSpaces: () => string[];
  allowlist: () => Allowlist | null;
  allowedFiles: () => AllowedFile[];
};

export type ScanSummary = { spaces: string[]; findings: number; files: number; unguarded: string[]; missingTransform: string[]; ms: number };

export class Scanner {
  private readonly d: ScanDeps;

  constructor(d: ScanDeps) {
    this.d = d;
  }

  /** Every space prefix of the instance the scan user can see, from the `/.config` of any reachable space; or the configured list. */
  async discover(token: string): Promise<string[]> {
    if (this.d.config.spaces.length) return [...this.d.config.spaces].sort();
    const known = new Set<string>([...this.d.seedSpaces(), ...this.d.state.spaces.keys()]);
    for (const space of [...known]) {
      try {
        const cfg = await this.d.sb.config(token, space);
        for (const p of cfg.spacePrefixes) known.add(p.replace(/^\//, ""));
        break;
      } catch {}
    }
    return [...known].sort();
  }

  /** One full scan over every space; updates the state and writes the report pages. */
  async run(): Promise<ScanSummary> {
    const t0 = performance.now();
    const { state, log } = this.d;
    if (state.scanning) throw new Error("a scan is already running");
    state.scanning = true;
    const summary: ScanSummary = { spaces: [], findings: 0, files: 0, unguarded: [], missingTransform: [], ms: 0 };
    try {
      const token = this.d.scanToken();
      const spaces = token ? await this.discover(token) : this.d.config.spaces.length ? this.d.config.spaces : [...new Set([...this.d.seedSpaces(), ...state.spaces.keys()])];
      for (const space of spaces) {
        const s = state.space(space);
        summary.spaces.push(space);
        if (!token) {
          s.guarded = false;
          s.unguardedReason = 'the credentials file has no line for the technical user "scan"';
          summary.unguarded.push(space);
          continue;
        }
        try {
          await this.scanSpace(space, token, s);
        } catch (e) {
          log.error("scan.space.failed", { space, error: (e as Error).message });
          s.guarded = false;
          s.unguardedReason = `the scan failed: ${(e as Error).message}`;
        }
        if (!s.guarded) summary.unguarded.push(space);
        if (s.guarded && s.transform !== "present") summary.missingTransform.push(space);
        summary.findings += s.findings.length;
        summary.files += s.files.length;
      }
    } finally {
      state.scanning = false;
    }
    summary.ms = Math.round(performance.now() - t0);
    log.info("scan.done", { ...summary });
    return summary;
  }

  private async scanSpace(space: string, token: string, s: SpaceState) {
    const { sb, config, log } = this.d;
    const t0 = performance.now();
    let readOnly: boolean;
    try {
      readOnly = (await sb.config(token, space)).readOnly;
    } catch (e) {
      s.guarded = false;
      s.unguardedReason = e instanceof SbError && (e.status === 403 || e.status === 401) ? 'the user "scan" is not a member of the space' : `cannot read the space's configuration: ${(e as Error).message}`;
      return;
    }
    if (readOnly) {
      s.guarded = false;
      s.unguardedReason = 'the user "scan" is a read member; it must be a write member to write the report page';
      return;
    }
    s.guarded = true;
    s.unguardedReason = null;

    // The transform in CONFIG.
    try {
      const cfg = await sb.read(token, space, "CONFIG.md");
      s.transform = hasTransform(cfg.body.toString("utf8")) ? "present" : "missing";
    } catch (e) {
      if (e instanceof SbError && e.status === 404) s.transform = "missing";
      else throw e;
    }

    // Pages outside CONFIG and Library/, and files that are not pages.
    const allow = this.d.allowlist();
    const files = await sb.list(token, space);
    const findings: Finding[] = [];
    const nonPages: FileFinding[] = [];
    const quarantined: string[] = [];
    const allowed = this.d.allowedFiles().filter((a) => a.space === space || a.space === "*");
    let pagesChecked = 0;
    const reportFile = `${config.reportPage}.md`;
    for (const f of files) {
      const page = pageNameOf(f.name);
      if (isCodePlace(page)) continue;
      if (!f.name.endsWith(".md")) {
        if (!allowed.some((a) => pathMatches(a.path, f.name))) nonPages.push({ file: f.name, contentType: f.contentType, size: f.size });
        continue;
      }
      if (f.name === reportFile) continue; // the server's own page
      if (!allow) continue; // without a valid allowlist the filter has nothing to decide with; the server refuses to serve anyway
      pagesChecked++;
      const read = await sb.read(token, space, f.name);
      const source = read.body.toString("utf8");
      const verdict = checkPage(source, allow);
      if (verdict.ok) continue;
      if (config.scanMode === "quarantine") {
        const neutralised = quarantine(source, verdict.violations);
        // The neutralised page must pass the filter itself; otherwise it stays a finding.
        if (checkPage(neutralised, allow).ok) {
          try {
            await sb.write(token, space, f.name, neutralised, { ifMatch: read.etag ?? undefined });
            quarantined.push(page);
            log.warn("scan.quarantined", { space, page, violations: verdict.violations.length });
            continue;
          } catch (e) {
            log.error("scan.quarantine.failed", { space, page, error: (e as Error).message });
          }
        } else {
          log.error("scan.quarantine.failed", { space, page, error: "the neutralised page still holds code" });
        }
      }
      for (const v of verdict.violations) findings.push({ page, line: v.line, rule: v.rule, detail: v.detail });
    }
    s.findings = findings;
    s.files = nonPages;
    s.quarantined = quarantined;
    s.lastScan = new Date();
    s.scanMs = Math.round(performance.now() - t0);
    s.pagesChecked = pagesChecked;
    s.filesSeen = files.length;
    s.findingsChangedSinceScan = false;
    void sb;
    await this.writeReport(space, token, s, files);
  }

  private async writeReport(space: string, token: string, s: SpaceState, files: SbFile[]) {
    const { sb, config, state, log } = this.d;
    const text = safeReport(renderReport(space, s, state, config, files.length));
    const file = `${config.reportPage}.md`;
    try {
      await sb.write(token, space, file, text);
    } catch (e) {
      log.error("scan.report.failed", { space, error: (e as Error).message });
    }
  }
}

/** A fence longer than any run of backticks in the text, so that the text cannot close it. */
const fenceFor = (text: string) => "`".repeat(Math.max(3, (text.match(/`+/g) ?? []).reduce((m, t) => Math.max(m, t.length), 0) + 1));

/**
 * Neutralises the violations in place, keeping the text visible: an executable fence becomes a
 * `lua` fence, a directive is wrapped in a code span (or a fenced block when it spans a blank
 * line, which would end a code span), a baked marker loses its `#`, and the page is tagged
 * #quarantined.
 */
export function quarantine(source: string, violations: Violation[]): string {
  const ranges = [...violations].sort((a, b) => b.from - a.from);
  let out = source;
  let lastFrom = Infinity;
  for (const v of ranges) {
    if (v.from >= lastFrom) continue; // the same directive reported twice
    lastFrom = v.from;
    const piece = out.slice(v.from, v.to);
    let replacement: string;
    if (v.rule === "fence" || v.rule === "fence-hidden") {
      replacement = piece.replace(/^([ \t]{0,3}(?:`{3,}|~{3,})[ \t]*)(space-lua|space-config|space-style)\b[^\n]*/, "$1lua");
    } else if (piece.startsWith("<!--#lua")) {
      replacement = "<!-- #lua" + piece.slice("<!--#lua".length);
    } else if (/\n[ \t]*\n/.test(piece)) {
      const fence = fenceFor(piece);
      replacement = `\n${fence}text\n${piece}\n${fence}\n`;
    } else {
      const ticks = fenceFor(piece).slice(2); // one more backtick than any run inside, at least one
      replacement = `${ticks}${piece}${ticks}`;
    }
    out = out.slice(0, v.from) + replacement + out.slice(v.to);
  }
  if (!/(^|\s)#quarantined(\s|$)/.test(out)) out = out.replace(/\s*$/, "\n\n#quarantined\n");
  return out;
}

/** The report page may contain no directive at all, whatever a page name, a detail or a file name holds. */
const NO_DIRECTIVES = compileAllowlist([]);

/**
 * Makes sure the report page is inert: if the rendered page holds a directive, a baked marker or an
 * executable fence (a page name such as `A ${...}` would smuggle one in), the whole report goes into
 * one fenced block that nothing inside can close.
 */
export function safeReport(text: string): string {
  const verdict = checkPage(text, NO_DIRECTIVES);
  if (verdict.ok && verdict.directives === 0) return text;
  const fence = fenceFor(text);
  return `# Report\n\nA name or a detail in this report would have been live Markdown; the report is shown as plain text.\n\n${fence}text\n${text}\n${fence}\n`;
}

/** Page names that are safe inside a wiki link; everything else goes into a code span. */
const LINKABLE = /^[A-Za-z0-9 _.()/-]+$/;
const pageRef = (page: string) => (LINKABLE.test(page) ? `[[${page}]]` : cell(page));

const cell = (s: string) => "`" + s.replace(/`/g, "'").replace(/\|/g, "\\|").replace(/\n/g, " ").replace(/\$\{/g, "$ {") + "`";

/** The report page (docs/security.md, section 8). Holds no directive: every detail is in a code span. */
export function renderReport(space: string, s: SpaceState, state: State, config: Config, fileCount: number): string {
  const lines: string[] = [];
  const now = new Date().toISOString();
  lines.push(`# ${config.reportPage}`, "");
  lines.push(`Written by the MCP server's scan as the user \`scan\` on ${now}; overwritten on every scan. What it means: [docs/security.md](https://github.com/finestream/silverbullet-mcp/blob/main/docs/security.md), sections 7 to 9.`, "");
  lines.push("## State", "");
  const refusal = state.refusal(space);
  const block = state.renderBlock(space);
  lines.push(`* Space: \`${space}\``);
  lines.push(`* Serving: ${refusal ? `**no**. ${cell(refusal)}` : "yes"}`);
  lines.push(`* Rendering: ${block ? `**blocked**. ${cell(block)}` : "available where the access list grants x"}`);
  lines.push(`* Transform block in CONFIG: ${s.transform === "present" ? "present" : "**missing**"}`);
  lines.push(`* Allowlist: ${state.allowlist.ok ? "valid" : `**invalid**: ${cell(state.allowlist.problems.join("; "))}`}`);
  lines.push(`* Last scan: ${s.lastScan?.toISOString() ?? "never"}, ${s.scanMs} ms, ${s.pagesChecked} page(s) checked, ${fileCount} file(s) seen`);
  lines.push(`* Scan mode: ${config.scanMode === "quarantine" ? "quarantine" : "report-only"}; interval: ${config.scanInterval === 0 ? "none (start and SIGHUP only)" : `${Math.round(config.scanInterval / 60000)} min`}`);
  lines.push("");
  lines.push(`## Findings (${s.findings.length})`, "");
  if (s.findings.length) {
    lines.push("| Page | Line | Rule | Detail |", "|---|---|---|---|");
    for (const f of s.findings) lines.push(`| ${pageRef(f.page)} | ${f.line} | ${cell(f.rule)} | ${cell(f.detail)} |`);
  } else if (!state.allowlist.ok) lines.push("Pages were not checked: the allowlist is invalid, and the server refuses to serve.");
  else lines.push("None: every page outside CONFIG and Library/ is data.");
  lines.push("");
  if (s.quarantined.length) {
    lines.push(`## Quarantined in this run (${s.quarantined.length})`, "");
    for (const p of s.quarantined) lines.push(`* ${pageRef(p)}`);
    lines.push("");
  }
  lines.push(`## Files that are not pages (${s.files.length})`, "");
  if (s.files.length) {
    lines.push("Outside the allowed-files list. The operator removes them or allows them by path.", "", "| File | Type | Size |", "|---|---|---|");
    for (const f of s.files) lines.push(`| ${cell(f.file)} | ${cell(f.contentType)} | ${f.size} |`);
  } else lines.push("None outside the allowed-files list.");
  lines.push("");
  if (state.relaxed.length) {
    lines.push("## Settings weaker than the shipped defaults", "");
    for (const r of state.relaxed) lines.push(`* ${cell(r)}`);
    lines.push("");
  }
  lines.push("## Statistics since start", "");
  lines.push(`* Server started: ${state.startedAt.toISOString()}`);
  lines.push(`* Users seen: ${[...state.usersSeen].sort().map((u) => `\`${u}\``).join(", ") || "none"}`);
  lines.push(`* Spaces seen: ${[...state.spacesSeen].sort().map((u) => `\`${u}\``).join(", ") || "none"}`);
  if (state.requests.size) {
    lines.push("", "| Tool | Calls |", "|---|---|");
    for (const [tool, n] of [...state.requests].sort()) lines.push(`| ${cell(tool)} | ${n} |`);
  }
  if (state.refusals.size) {
    lines.push("", "| Refused by | Calls |", "|---|---|");
    for (const [control, n] of [...state.refusals].sort()) lines.push(`| ${cell(control)} | ${n} |`);
  }
  lines.push("");
  return lines.join("\n");
}
