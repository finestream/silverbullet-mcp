// Runs the server against the compose test instance (test/README.md) for the
// integration tests: writes the credentials file, the access list and the
// allowlist into a temporary directory from the tokens the bootstrap stored,
// spawns `node src/main.ts`, waits for its "listening" line, and gives the
// tests an MCP client per bearer.

import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SB_URL, T } from "../lib/env.ts";
import { sha256hex } from "../../src/credentials.ts";
import { SHIPPED_ALLOWLIST } from "../../src/filter/allowlist.ts";

export const BEARERS = { alice: "alice-client-secret", bob: "bob-client-secret", carol: "carol-client-secret" };

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

/** The credentials file of the fixtures: alice (default alpha), bob (default beta), carol (no SilverBullet rights anywhere) and scan. */
export function credentialsFile(opts: { scan?: boolean; groups?: Record<string, string> } = {}): string {
  const g = (u: string, d: string) => opts.groups?.[u] ?? d;
  const lines = [
    `alice ${T.alice} alpha ${g("alice", "agents")} ${sha256hex(BEARERS.alice)}`,
    `bob ${T.bob} beta ${g("bob", "agents")} ${sha256hex(BEARERS.bob)}`,
    `carol ${T.alice} beta ${g("carol", "agents")} ${sha256hex(BEARERS.carol)}`, // alice's token under another name: SilverBullet grants nothing on beta
  ];
  if (opts.scan !== false) lines.push(`scan ${T.scan} - - -`);
  return lines.join("\n") + "\n";
}

/** The shipped default of the access list for the fixtures, plus what a test adds. */
export const DEFAULT_ACCESS_LIST = `
@agents * /          r
@agents * CONFIG     -
@agents * SETTINGS   -
@agents * Library/   -
@agents * Projects/  rw
alice   alpha Agent/ rwd
`;

export type ServerOptions = {
  credentials?: string;
  accessList?: string;
  allowlist?: string[];
  allowedFiles?: string;
  env?: Record<string, string>;
};

export type RunningServer = {
  url: string;
  dir: string;
  process: ChildProcess;
  logs: string[];
  stop(): Promise<void>;
  /** A SIGHUP reloads the files and runs a scan; resolves when the scan is done. */
  rescan(): Promise<void>;
  waitFor(event: string, timeoutMs?: number): Promise<Record<string, unknown>>;
};

export async function startServer(opts: ServerOptions = {}): Promise<RunningServer> {
  const dir = mkdtempSync(join(tmpdir(), "sbmcp-test-"));
  writeFileSync(join(dir, "credentials"), opts.credentials ?? credentialsFile());
  writeFileSync(join(dir, "access-list"), opts.accessList ?? DEFAULT_ACCESS_LIST);
  writeFileSync(join(dir, "allowlist"), (opts.allowlist ?? SHIPPED_ALLOWLIST).join("\n") + "\n");
  if (opts.allowedFiles !== undefined) writeFileSync(join(dir, "allowed-files"), opts.allowedFiles);
  const env = {
    ...process.env,
    SB_URL,
    PORT: "0",
    MCP_CREDENTIALS_FILE: join(dir, "credentials"),
    MCP_ACCESS_LIST_FILE: join(dir, "access-list"),
    MCP_ALLOWLIST_FILE: join(dir, "allowlist"),
    MCP_ALLOWED_FILES_FILE: join(dir, "allowed-files"),
    MCP_SCAN_INTERVAL: "0",
    ...opts.env,
  };
  const child = spawn(process.execPath, [join(ROOT, "src/main.ts")], { env, stdio: ["ignore", "pipe", "pipe"] });
  const logs: string[] = [];
  const waiters: Array<{ event: string; resolve: (f: Record<string, unknown>) => void }> = [];
  let buffer = "";
  child.stdout!.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      logs.push(line);
      let parsed: Record<string, unknown> | null = null;
      try {
        parsed = JSON.parse(line);
      } catch {}
      if (parsed) for (const w of [...waiters]) if (w.event === parsed.event) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(parsed);
      }
    }
  });
  child.stderr!.on("data", (chunk: Buffer) => logs.push(chunk.toString()));
  const waitFor = (event: string, timeoutMs = 30_000) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no "${event}" within ${timeoutMs} ms; log:\n${logs.join("\n")}`)), timeoutMs);
      waiters.push({ event, resolve: (f) => { clearTimeout(timer); resolve(f); } });
    });
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  const listening = await Promise.race([waitFor("listening"), exited.then(() => { throw new Error(`server exited; log:\n${logs.join("\n")}`); })]);
  const url = `http://127.0.0.1:${listening.port}`;
  return {
    url,
    dir,
    process: child,
    logs,
    waitFor,
    async rescan() {
      const done = waitFor("scan.done");
      child.kill("SIGHUP");
      await done;
    },
    async stop() {
      child.kill("SIGTERM");
      await Promise.race([exited, new Promise((r) => setTimeout(r, 3000))]);
      if (child.exitCode === null) child.kill("SIGKILL");
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export type ToolResult = { text: string; data: Record<string, any> | undefined; isError: boolean };

export type McpClient = {
  call(tool: string, args?: Record<string, unknown>): Promise<ToolResult>;
  tools(): Promise<string[]>;
  close(): Promise<void>;
};

export async function connect(url: string, bearer: string): Promise<McpClient> {
  const client = new Client({ name: "integration-test", version: "0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${bearer}` } } });
  await client.connect(transport);
  return {
    async call(tool, args = {}) {
      const r = (await client.callTool({ name: tool, arguments: args })) as { content: Array<{ type: string; text?: string }>; structuredContent?: Record<string, any>; isError?: boolean };
      return { text: r.content.map((c) => c.text ?? "").join("\n"), data: r.structuredContent, isError: r.isError === true };
    },
    async tools() {
      return (await client.listTools()).tools.map((t) => t.name);
    },
    close: () => client.close(),
  };
}

export const unique = (prefix: string) => `${prefix} ${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
