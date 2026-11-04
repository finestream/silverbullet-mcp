// The instance the checks run against: URL and tokens from test/.state/env
// (written by the bootstrap) or from the environment (SB_URL, SB_TOKEN_*).
// The fixtures are fixed: users alice (write + Runtime API on alpha, nothing
// on beta), bob (read on alpha, write + Runtime API on beta) and scan (write on
// both, the server's technical user), plus admin.

import { existsSync, readFileSync } from "node:fs";
import { client } from "./sb.ts";

export const STATE_DIR = new URL("../.state/", import.meta.url);
export const SEED_DIR = new URL("../seed/", import.meta.url);
export const REPORT_DIR = new URL("../report/", import.meta.url);

export const DEFAULT_URL = "http://127.0.0.1:3300";
export const DEFAULT_ADMIN_PASSWORD = "admin-test-password";
export const DEFAULT_USER_PASSWORD = "user-test-password";

export const SPACES = { alpha: "alpha", beta: "beta" } as const;
export const USERS = ["alice", "bob"] as const;
/** The server's technical user (docs/security.md, section 7): a write member of both spaces. */
export const SCAN_USER = "scan";

export function loadEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  const file = new URL("env", STATE_DIR);
  if (existsSync(file)) {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const m = line.match(/^([A-Z_]+)=(.*)$/);
      if (m) out[m[1]] = m[2];
    }
  }
  for (const k of ["SB_URL", "SB_TOKEN_ADMIN", "SB_TOKEN_ALICE", "SB_TOKEN_BOB", "SB_TOKEN_SCAN", "SB_USER_PASSWORD", "SB_ADMIN_PASSWORD"]) {
    if (process.env[k]) out[k] = process.env[k]!;
  }
  return out;
}

/** Read fresh on every use: the bootstrap may have written the state after this module was loaded. */
function need(key: string): string {
  const v = loadEnv()[key];
  if (!v) throw new Error(`${key} is not set: run the bootstrap first (node test/run.ts does it) or export it`);
  return v;
}

export const SB_URL = loadEnv().SB_URL ?? DEFAULT_URL;
export const sb = client(SB_URL);

/** Tokens, resolved lazily so that importing this module without an instance does not throw. */
export const T = {
  get admin() {
    return need("SB_TOKEN_ADMIN");
  },
  get alice() {
    return need("SB_TOKEN_ALICE");
  },
  get bob() {
    return need("SB_TOKEN_BOB");
  },
  get scan() {
    return need("SB_TOKEN_SCAN");
  },
};
export const userPassword = () => loadEnv().SB_USER_PASSWORD ?? DEFAULT_USER_PASSWORD;
export const S = SPACES;

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Polls until `fn` returns a truthy value or the timeout passes; returns the value and the seconds waited. */
export async function until<V>(fn: () => Promise<V>, timeoutMs: number, stepMs = 250): Promise<{ value: V | undefined; seconds: number }> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const value = await fn();
    if (value) return { value, seconds: (Date.now() - t0) / 1000 };
    await sleep(stepMs);
  }
  return { value: undefined, seconds: (Date.now() - t0) / 1000 };
}

/** The SilverBullet version of the instance, as `system.getVersion()` reports it; "unknown" if the runtime is unavailable. */
export async function version(): Promise<string> {
  try {
    const r = await sb.lua(T.alice, S.alpha, "return system.getVersion()");
    return typeof r.result === "string" ? r.result : "unknown";
  } catch {
    return "unknown";
  }
}

/** `2.12.1` from a version string such as `2.12.1` or `2.12.1-0-gabcdef`. */
export const semver = (v: string) => v.match(/^\d+\.\d+\.\d+/)?.[0] ?? v;
