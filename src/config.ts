// Configuration from the environment (README, "Configuration"): where
// SilverBullet is, the three configuration files, the file types, the scan
// settings. Secrets are files (the credentials file); nothing secret is read
// from a variable.

import { readFileSync, statSync, watchFile, unwatchFile } from "node:fs";

export type ScanMode = "report" | "quarantine";

export type Config = {
  sbUrl: string;
  port: number;
  credentialsFile: string;
  accessListFile: string;
  allowlistFile: string;
  allowedFilesFile: string;
  /** File types the server writes; shipped default `.md` only. */
  fileTypes: string[];
  /** Milliseconds between scans; 0 means no scheduled scan (the start scan still runs). */
  scanInterval: number;
  scanMode: ScanMode;
  /** The report page, written at the top level of every guarded space. */
  reportPage: string;
  /** The spaces the server guards; empty means every space the scan user can see. */
  spaces: string[];
  /** Tool calls per user and minute; 0 means no limit. */
  rateLimit: number;
  logLevel: "debug" | "info";
  /** Runtime API calls in flight at once, over all runtimes (docs/architecture.md, section 5). */
  renderParallel: number;
  /** Milliseconds a render or screenshot call may take in all, queue included. */
  renderTimeout: number;
  /** Milliseconds a render waits for the runtime's index to hold a write made through the server, before the reboot fallback (docs/security.md, section 12). */
  indexWait: number;
};

export const DEFAULT_FILE_TYPES = [".md"];

/** Types SilverBullet executes or serves as code; they can never be written through the server. */
export const NEVER_WRITTEN_TYPES = [".plug.js", ".js", ".mjs", ".cjs", ".html", ".htm", ".xhtml", ".svg", ".lua"];

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const dir = env.MCP_CONFIG_DIR ?? "/etc/silverbullet-mcp";
  return {
    sbUrl: (env.SB_URL ?? "http://silverbullet:3000").replace(/\/+$/, ""),
    port: Number(env.PORT ?? 4000),
    credentialsFile: env.MCP_CREDENTIALS_FILE ?? "/run/secrets/credentials",
    accessListFile: env.MCP_ACCESS_LIST_FILE ?? `${dir}/access-list`,
    allowlistFile: env.MCP_ALLOWLIST_FILE ?? `${dir}/allowlist`,
    allowedFilesFile: env.MCP_ALLOWED_FILES_FILE ?? `${dir}/allowed-files`,
    fileTypes: parseFileTypes(env.MCP_FILE_TYPES ?? DEFAULT_FILE_TYPES.join(",")),
    scanInterval: parseDuration(env.MCP_SCAN_INTERVAL ?? "15m"),
    scanMode: env.MCP_SCAN_MODE === "quarantine" ? "quarantine" : "report",
    reportPage: env.MCP_REPORT_PAGE ?? "MCP Server",
    spaces: (env.MCP_SPACES ?? "").split(",").map((s) => s.trim().replace(/^\//, "")).filter(Boolean),
    rateLimit: Number(env.MCP_RATE_LIMIT ?? 120),
    logLevel: env.MCP_LOG_LEVEL === "debug" ? "debug" : "info",
    renderParallel: Number(env.MCP_RENDER_PARALLEL ?? 4),
    renderTimeout: parseDuration(env.MCP_RENDER_TIMEOUT ?? "90s"),
    indexWait: parseDuration(env.MCP_INDEX_WAIT ?? "5s"),
  };
}

export function parseFileTypes(text: string): string[] {
  return text
    .split(",")
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean)
    .map((t) => (t.startsWith(".") ? t : `.${t}`));
}

/** Problems with the configured file types; a type that executes or is served as code cannot be added. */
export function validateFileTypes(types: readonly string[]): string[] {
  const problems: string[] = [];
  for (const t of types) {
    const never = NEVER_WRITTEN_TYPES.find((n) => n === t || n.endsWith(t));
    if (never) problems.push(`"${t}" covers "${never}", a type SilverBullet executes or serves as code`);
  }
  return problems;
}

/** `0`, `30s`, `15m`, `2h`, `1d`, or plain seconds. */
export function parseDuration(text: string): number {
  const m = text.trim().match(/^(\d+)\s*(ms|s|m|h|d)?$/);
  if (!m) throw new Error(`not a duration: "${text}" (use 0, 30s, 15m, 2h or 1d)`);
  const n = Number(m[1]);
  return n * ({ ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] ?? "s"] as number);
}

/**
 * A configuration file parsed into a value, re-read when it changes on disk (polled, so that
 * bind-mounted secrets and symlinked files work alike). A file that cannot be read keeps the
 * last good value and records the problem.
 */
export class WatchedFile<T> {
  value: T | null = null;
  problems: string[] = [];
  present = false;
  private mtime = 0;
  private listeners: Array<() => void> = [];

  readonly path: string;
  private readonly parse: (text: string) => { value: T; problems: string[] };
  private readonly required: boolean;

  constructor(path: string, parse: (text: string) => { value: T; problems: string[] }, required = true) {
    this.path = path;
    this.parse = parse;
    this.required = required;
  }

  load(): this {
    try {
      const stat = statSync(this.path);
      this.mtime = stat.mtimeMs;
      const text = readFileSync(this.path, "utf8");
      const { value, problems } = this.parse(text);
      this.value = value;
      this.problems = problems;
      this.present = true;
    } catch (e) {
      this.present = false;
      this.problems = this.required ? [`cannot read ${this.path}: ${(e as Error).message}`] : [];
      if (!this.required) this.value = this.parse("").value;
    }
    return this;
  }

  watch(intervalMs = 2000): this {
    watchFile(this.path, { interval: intervalMs }, (curr) => {
      if (curr.mtimeMs !== this.mtime || (curr.mtimeMs === 0) !== !this.present) {
        this.load();
        for (const l of this.listeners) l();
      }
    });
    return this;
  }

  onChange(listener: () => void): this {
    this.listeners.push(listener);
    return this;
  }

  close() {
    unwatchFile(this.path);
  }
}
