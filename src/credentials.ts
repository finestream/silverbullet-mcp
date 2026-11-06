// The credentials file (docs/security.md, section 3; docs/architecture.md,
// section 2): one line per SilverBullet user with that user's own API token,
// its default space, its groups, the SHA-256 hashes of its static bearers and,
// optionally, the e-mail addresses Cloudflare Access signs the user in with.
// The technical user of the scan (`MCP_SCAN_USER`, default `scan`) is one more line.

import { createHash, timingSafeEqual } from "node:crypto";

export type Credential = {
  user: string;
  /** The user's SilverBullet API token. Never leaves the server. */
  token: string;
  /** The space used when a tool call names none; `-` means none. */
  defaultSpace: string | null;
  groups: string[];
  /** Hex SHA-256 digests of the client bearers, one per client. */
  bearerHashes: string[];
  /** The e-mail addresses that select this line for a request through Cloudflare Access, in lower case. */
  emails: string[];
  line: number;
};

export type Credentials = {
  users: Map<string, Credential>;
  /** The user a client bearer belongs to, or null. Constant-time comparison per stored hash. */
  byBearer(bearer: string): Credential | null;
  /** The user an e-mail address belongs to, in any case, or null. */
  byEmail(email: string): Credential | null;
};

const HEX64 = /^[0-9a-f]{64}$/;
/** Enough to catch a field that is not an address; Access, not this file, decides which addresses exist. */
const EMAIL = /^[^\s@,]+@[^\s@,]+$/;

export const sha256hex = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

/**
 * Format, whitespace-separated: `user token default-space groups bearer-hashes [emails]`; `groups`,
 * `bearer-hashes` and `emails` are comma-separated or `-`; `default-space` may be `-`; `emails`
 * may be left out; `#` starts a comment.
 */
export function parseCredentials(text: string): { credentials: Credentials; problems: string[] } {
  const users = new Map<string, Credential>();
  const hashes = new Map<string, string>();
  const emails = new Map<string, string>();
  const problems: string[] = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.replace(/(^|\s)#.*$/, "").trim();
    if (!line) return;
    const t = line.split(/\s+/);
    if (t.length !== 5 && t.length !== 6) {
      problems.push(`line ${i + 1}: expected "user token default-space groups bearer-hashes [emails]" (5 or 6 fields), got ${t.length}`);
      return;
    }
    const [user, token, space, groups, bearers, addresses = "-"] = t;
    if (users.has(user)) {
      problems.push(`line ${i + 1}: user "${user}" appears twice`);
      return;
    }
    const bearerHashes = bearers === "-" ? [] : bearers.split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
    for (const h of bearerHashes) {
      if (!HEX64.test(h)) problems.push(`line ${i + 1}: "${h.slice(0, 12)}…" is not a hex SHA-256 digest`);
      else if (hashes.has(h)) problems.push(`line ${i + 1}: bearer hash already used by "${hashes.get(h)}"`);
      else hashes.set(h, user);
    }
    const own: string[] = [];
    for (const e of addresses === "-" ? [] : addresses.split(",").map((a) => a.trim().toLowerCase()).filter(Boolean)) {
      if (!EMAIL.test(e)) problems.push(`line ${i + 1}: "${e.slice(0, 40)}" is not an e-mail address`);
      else if (emails.has(e)) problems.push(`line ${i + 1}: e-mail address already used by "${emails.get(e)}"`);
      else {
        emails.set(e, user);
        own.push(e);
      }
    }
    users.set(user, {
      user,
      token,
      defaultSpace: space === "-" ? null : space,
      groups: groups === "-" ? [] : groups.split(",").map((g) => g.trim()).filter(Boolean),
      bearerHashes,
      emails: own,
      line: i + 1,
    });
  });
  const credentials: Credentials = {
    users,
    byBearer(bearer: string) {
      const digest = Buffer.from(sha256hex(bearer), "hex");
      let found: string | null = null;
      for (const [hash, user] of hashes) {
        // Every stored hash is compared, so the time does not depend on which one matches.
        if (timingSafeEqual(digest, Buffer.from(hash, "hex"))) found = user;
      }
      return found ? (users.get(found) ?? null) : null;
    },
    byEmail(email: string) {
      const user = emails.get(email.toLowerCase());
      return user ? (users.get(user) ?? null) : null;
    },
  };
  return { credentials, problems };
}
