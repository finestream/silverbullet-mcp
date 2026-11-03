// Bootstraps a SilverBullet instance in multi-space mode through its admin API:
// Runtime API on, users alice, bob and scan (the server's technical user),
// spaces alpha and beta with their grants, one API token per user, and the
// seed pages. Idempotent: a second run keeps what exists, except CONFIG, which
// is always rewritten (the checks change it), and beta's index page, which
// SilverBullet creates with code in it.
//
// Writes test/.state/env with SB_URL and the tokens.

import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";
import { client } from "./sb.ts";
import { configPage } from "./transform.ts";
import { DEFAULT_ADMIN_PASSWORD, DEFAULT_URL, DEFAULT_USER_PASSWORD, SEED_DIR, STATE_DIR, SPACES, USERS, SCAN_USER } from "./env.ts";

export type BootstrapOptions = {
  url?: string;
  adminPassword?: string;
  userPassword?: string;
  log?: (line: string) => void;
};

const GRANTS: Record<string, Record<string, { role: "read" | "write"; runtimeApi?: boolean }>> = {
  alpha: { alice: { role: "write", runtimeApi: true }, bob: { role: "read" }, scan: { role: "write", runtimeApi: false } },
  beta: { bob: { role: "write", runtimeApi: true }, scan: { role: "write", runtimeApi: false } },
};

/** The space a user can certainly read, to validate a stored token. */
const PROBE_SPACE: Record<string, string> = { admin: "alpha", alice: "alpha", bob: "beta", scan: "alpha" };

export async function bootstrap(opts: BootstrapOptions = {}) {
  const url = opts.url ?? process.env.SB_URL ?? DEFAULT_URL;
  const adminPassword = opts.adminPassword ?? process.env.SB_ADMIN_PASSWORD ?? DEFAULT_ADMIN_PASSWORD;
  const userPassword = opts.userPassword ?? process.env.SB_USER_PASSWORD ?? DEFAULT_USER_PASSWORD;
  const log = opts.log ?? ((line: string) => console.log(`bootstrap: ${line}`));
  const sb = client(url);
  const stateDir = fileURLToPath(STATE_DIR);
  mkdirSync(stateDir, { recursive: true });

  const cookie = await sb.admin.login("admin", adminPassword);
  const admin = { cookie };
  const expect = (what: string, r: { status: number; text: string }, ok: number[] = [200]) => {
    if (!ok.includes(r.status)) throw new Error(`${what} failed with ${r.status}: ${r.text}`);
    log(`${what} (${r.status})`);
  };

  expect("runtime API on", await sb.admin.api(admin, "PUT", "/admin/server-config", { runtimeApi: true }));

  const users = JSON.stringify((await sb.admin.api(admin, "GET", "/admin/users")).json);
  for (const user of [...USERS, SCAN_USER]) {
    if (users.includes(`"${user}"`)) log(`user ${user} exists`);
    else expect(`user ${user}`, await sb.admin.api(admin, "POST", "/admin/users", { username: user, password: userPassword }));
  }

  const spaces = JSON.stringify((await sb.admin.api(admin, "GET", "/admin/spaces")).json);
  for (const space of Object.values(SPACES)) {
    if (spaces.includes(`"name":"${space}"`)) log(`space ${space} exists`);
    else {
      expect(
        `space ${space}`,
        await sb.admin.api(admin, "POST", "/admin/spaces", {
          name: space,
          folder: `spaces/${space}`,
          binding: { prefix: `/${space}` },
          members: GRANTS[space],
        }),
      );
    }
  }

  // Spaces created by an earlier bootstrap may lack the scan user: add it.
  const spaceList = (await sb.admin.api(admin, "GET", "/admin/spaces")).json as Record<string, { name: string; members?: Record<string, unknown> }> | null;
  for (const [id, space] of Object.entries(spaceList ?? {})) {
    if (GRANTS[space.name] && space.members && !(SCAN_USER in space.members)) {
      expect(`member scan on ${space.name}`, await sb.admin.api(admin, "PATCH", `/admin/spaces/${id}`, { members: { ...space.members, [SCAN_USER]: GRANTS[space.name][SCAN_USER] } }));
    }
  }

  const tokens: Record<string, string> = {};
  for (const user of ["admin", ...USERS, SCAN_USER]) {
    const file = join(stateDir, `${user}.token`);
    const stored = existsSync(file) ? readFileSync(file, "utf8").trim() : "";
    if (stored && (await sb.config(stored, PROBE_SPACE[user])).status === 200) {
      tokens[user] = stored;
      log(`token for ${user} still valid`);
      continue;
    }
    await sb.admin.api(admin, "DELETE", `/admin/users/${user}/tokens/test`);
    const r = await sb.admin.api(admin, "POST", `/admin/users/${user}/tokens`, { name: "test" });
    expect(`token for ${user}`, r);
    const token = (r.json as { token?: string })?.token;
    if (!token) throw new Error(`no token in the response for ${user}: ${r.text}`);
    writeFileSync(file, token + "\n");
    tokens[user] = token;
  }

  // Seed pages: create-only, so edits made by checks survive a re-run. CONFIG is always rewritten.
  const seedRoot = fileURLToPath(SEED_DIR);
  for (const space of readdirSync(seedRoot)) {
    const spaceDir = join(seedRoot, space);
    if (!statSync(spaceDir).isDirectory()) continue;
    for (const file of walk(spaceDir)) {
      const path = relative(spaceDir, file).split("\\").join("/");
      const r = await sb.write(tokens.admin, space, path, readFileSync(file), { "If-None-Match": "*" });
      if (r.status === 412) continue;
      expect(`seeded ${space}/${path}`, r, [200, 201, 204]);
    }
  }
  expect("CONFIG of alpha", await sb.write(tokens.admin, "alpha", "CONFIG.md", configPage("shipped")), [200, 201, 204]);
  expect("CONFIG of beta", await sb.write(tokens.admin, "beta", "CONFIG.md", configPage("shipped")), [200, 201, 204]);
  // SilverBullet's stock index page calls config.get and widgets.*; beta is kept clean for the server's scan.
  expect("index of beta", await sb.write(tokens.admin, "beta", "index.md", readFileSync(join(seedRoot, "beta", "index.md"))), [200, 201, 204]);

  const envText = [
    `SB_URL=${url}`,
    `SB_TOKEN_ADMIN=${tokens.admin}`,
    `SB_TOKEN_ALICE=${tokens.alice}`,
    `SB_TOKEN_BOB=${tokens.bob}`,
    `SB_TOKEN_SCAN=${tokens.scan}`,
    `SB_USER_PASSWORD=${userPassword}`,
    "",
  ].join("\n");
  writeFileSync(join(stateDir, "env"), envText);
  log("done; tokens in test/.state/env");
  return { url, tokens };
}

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) yield* walk(p);
    else yield p;
  }
}
