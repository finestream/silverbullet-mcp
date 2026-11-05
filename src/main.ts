// Entry point. `node src/main.ts` runs the server; `--scan` runs one scan and
// exits (installation, docs/security.md section 7); `--hash` prints the
// SHA-256 of a client bearer read from stdin, for the credentials file.

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { loadConfig, validateFileTypes, WatchedFile, DEFAULT_FILE_TYPES, type Config } from "./config.ts";
import { parseCredentials, sha256hex, type Credentials } from "./credentials.ts";
import { compileAccessList, parseAccessList, rendersWithDenials, type AccessList, type Subject } from "./access.ts";
import { compileAllowlist, parseAllowlist, validateAllowlist, SHIPPED_ALLOWLIST, type Allowlist } from "./filter/allowlist.ts";
import { parseAllowedFiles, Scanner, type AllowedFile } from "./scan.ts";
import { SilverBullet } from "./sb.ts";
import { State } from "./state.ts";
import { log } from "./log.ts";
import { createHttpServer, staticBearerAuth } from "./server.ts";
import { Renderer } from "./render.ts";

const { version } = createRequire(import.meta.url)("../package.json") as { version: string };

export type App = ReturnType<typeof buildApp>;

/** Loads the configuration files and wires the parts; used by the server and by the CLI modes. */
export function buildApp(config: Config) {
  log.setLevel(config.logLevel);
  const state = new State(config.reportPage, config.scanUser);
  const sb = new SilverBullet(config.sbUrl);

  const credentials = new WatchedFile<Credentials>(config.credentialsFile, (t) => {
    const r = parseCredentials(t);
    return { value: r.credentials, problems: r.problems };
  });
  const accessList = new WatchedFile<AccessList>(config.accessListFile, (t) => {
    const r = parseAccessList(t);
    return { value: compileAccessList(r.entries), problems: r.problems };
  });
  const allowlist = new WatchedFile<Allowlist>(config.allowlistFile, (t) => {
    const entries = parseAllowlist(t);
    return { value: compileAllowlist(entries), problems: validateAllowlist(entries) };
  });
  const allowedFiles = new WatchedFile<AllowedFile[]>(config.allowedFilesFile, parseAllowedFiles, false);
  const files = [credentials, accessList, allowlist, allowedFiles];

  const refresh = () => {
    state.credentials = { ok: credentials.present && credentials.problems.length === 0, problems: credentials.problems };
    state.accessList = { ok: accessList.present && accessList.problems.length === 0, problems: accessList.problems };
    state.allowlist = { ok: allowlist.present && allowlist.problems.length === 0, problems: allowlist.problems };
    state.fileTypes = { ok: validateFileTypes(config.fileTypes).length === 0, problems: validateFileTypes(config.fileTypes) };
    state.relaxed = relaxedSettings(config, allowlist.value, accessList.value, subjectsOf(credentials.value));
    for (const f of files) if (f.problems.length) log.warn("config.problems", { file: f.path, problems: f.problems });
  };
  for (const f of files) f.load().onChange(() => {
    log.info("config.reloaded", { file: f.path });
    refresh();
  });
  refresh();

  const scanner = new Scanner({
    sb,
    state,
    config,
    log,
    scanToken: () => credentials.value?.users.get(config.scanUser)?.token ?? null,
    seedSpaces: () => [...new Set([...(credentials.value?.users.values() ?? [])].map((u) => u.defaultSpace).filter((s): s is string => !!s))],
    allowlist: () => (state.allowlist.ok ? allowlist.value : null),
    allowedFiles: () => allowedFiles.value ?? [],
    accessList: () => (state.accessList.ok ? accessList.value : null),
    subjects: () => subjectsOf(credentials.value),
  });

  const renderer = new Renderer({ sb, state, config, log });

  return { config, state, sb, credentials, accessList, allowlist, allowedFiles, scanner, renderer, refresh, files, version };
}

/** The users of the credentials file as the access list sees them. */
const subjectsOf = (credentials: Credentials | null): Subject[] => [...(credentials?.users.values() ?? [])].map((u) => ({ user: u.user, groups: u.groups }));

/** Settings weaker than the shipped defaults (docs/security.md, section 11), reported once. */
function relaxedSettings(config: Config, allow: Allowlist | null, acl: AccessList | null, subjects: readonly Subject[]): string[] {
  const out: string[] = [];
  if (allow) {
    const extra = allow.entries.filter((e) => !SHIPPED_ALLOWLIST.includes(e));
    const reviewed = extra.filter((e) => allow.excepts(e.split(".")));
    const other = extra.filter((e) => !reviewed.includes(e));
    if (other.length) out.push(`allowlist entries beyond the shipped list: ${other.join(", ")}`);
    if (reviewed.length) out.push(`allowlist entries naming reviewed members of never-allowed namespaces: ${reviewed.join(", ")}`);
  }
  const extraTypes = config.fileTypes.filter((t) => !DEFAULT_FILE_TYPES.includes(t));
  if (extraTypes.length) out.push(`file types beyond .md: ${extraTypes.join(", ")}`);
  if (config.scanInterval === 0) out.push("no scheduled scan (MCP_SCAN_INTERVAL=0): findings are seen at start and on SIGHUP only");
  if (config.scanMode === "quarantine") out.push("scan in quarantine mode: the scan edits pages that hold code");
  if (acl) {
    for (const e of acl.entries) {
      if (e.path === "Library/" || e.path.startsWith("Library/") || e.path === "CONFIG" || e.path === "SETTINGS") {
        if (e.rights.has("w") || e.rights.has("d")) out.push(`write access for ${e.subject} on ${e.path} (access list line ${e.line}): the write filter does not apply there`);
      }
    }
    out.push(...rendersWithDenials(acl, subjects));
  }
  return out;
}

async function serve(config: Config) {
  const app = buildApp(config);
  const { state } = app;
  log.info("start", { version, sbUrl: config.sbUrl, port: config.port, scanMode: config.scanMode, scanInterval: config.scanInterval, scanUser: config.scanUser, fileTypes: config.fileTypes, renderParallel: config.renderParallel, renderTimeout: config.renderTimeout, indexWait: config.indexWait });
  for (const r of state.relaxed) log.warn("config.relaxed", { setting: r });
  for (const f of app.files) f.watch();

  // The start scan runs before the server listens, so that the state is known from the first request.
  await app.scanner.run().catch((e) => log.error("scan.failed", { error: (e as Error).message }));

  const server = createHttpServer({
    auth: staticBearerAuth(() => (state.credentials.ok ? app.credentials.value : null)),
    context: (user) => ({ user, sb: app.sb, acl: app.accessList.value!, subjects: subjectsOf(app.credentials.value), allow: app.allowlist.value ?? compileAllowlist([]), config, state, log, renderer: app.renderer }),
    state,
    log,
    rateLimit: config.rateLimit,
    version,
    configured: () => ({ ok: state.credentials.ok && state.accessList.ok, problems: [...state.credentials.problems, ...state.accessList.problems] }),
  });
  server.listen(config.port, () => {
    const address = server.address();
    log.info("listening", { port: typeof address === "object" && address ? address.port : config.port });
  });

  let timer: NodeJS.Timeout | null = null;
  if (config.scanInterval > 0) {
    timer = setInterval(() => {
      if (!state.scanning) void app.scanner.run().catch((e) => log.error("scan.failed", { error: (e as Error).message }));
    }, config.scanInterval);
  }
  process.on("SIGHUP", () => {
    log.info("sighup");
    for (const f of app.files) f.load();
    app.refresh();
    if (!state.scanning) void app.scanner.run().catch((e) => log.error("scan.failed", { error: (e as Error).message }));
  });
  const shutdown = () => {
    log.info("stop");
    if (timer) clearInterval(timer);
    for (const f of app.files) f.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}

async function scanOnce(config: Config) {
  const app = buildApp(config);
  const { state } = app;
  for (const r of state.relaxed) log.warn("config.relaxed", { setting: r });
  const summary = await app.scanner.run();
  const lines: string[] = [];
  lines.push(`Scan of ${summary.spaces.length} space(s) in ${summary.ms} ms: ${summary.findings} finding(s), ${summary.files} file(s) that are not pages.`);
  for (const s of state.spaces.values()) {
    lines.push(`- ${s.space}: ${s.guarded ? `guarded, transform ${s.transform}, ${s.findings.length} finding(s), ${s.files.length} non-page file(s)` : `NOT guarded: ${s.unguardedReason}`}`);
    for (const f of s.findings) lines.push(`    ${f.page}:${f.line} ${f.rule}: ${f.detail}`);
    for (const f of s.files) lines.push(`    file ${f.file} (${f.contentType})`);
  }
  const refusal = state.globalRefusal();
  if (refusal) lines.push(refusal);
  console.error(lines.join("\n"));
  process.exit(refusal || !state.credentials.ok ? 2 : summary.findings + summary.files + summary.unguarded.length + summary.missingTransform.length > 0 ? 1 : 0);
}

const mode = process.argv[2];
if (mode === "--hash") {
  const secret = readFileSync(0, "utf8").replace(/\r?\n$/, "");
  process.stdout.write(sha256hex(secret) + "\n");
} else if (mode === "--scan") {
  await scanOnce(loadConfig());
} else if (mode === undefined) {
  await serve(loadConfig());
} else {
  console.error(`usage: node src/main.ts [--scan | --hash]`);
  process.exit(2);
}
