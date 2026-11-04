// What the server knows about itself and the spaces it guards: the result of
// the configuration checks, the result of the last scan per space, and the
// statistics the report page shows. The refuse-to-serve and render-block
// decisions (docs/security.md, sections 9 and 7) are read from here.

export type Finding = { page: string; line: number; rule: string; detail: string };
export type FileFinding = { file: string; contentType: string; size: number };

export type SpaceState = {
  space: string;
  /** Whether the scan user reaches the space (as a write member). */
  guarded: boolean;
  /** Why the space is not guarded, when it is not. */
  unguardedReason: string | null;
  transform: "present" | "missing" | "unchecked";
  findings: Finding[];
  files: FileFinding[];
  /** Pages the last scan quarantined. */
  quarantined: string[];
  lastScan: Date | null;
  scanMs: number;
  pagesChecked: number;
  filesSeen: number;
  /** Set when a write through the server removed findings after the last scan. */
  findingsChangedSinceScan: boolean;
};

export type Check = { ok: boolean; problems: string[] };

/** A page written or deleted through the server, which a render in that space waits for (docs/security.md, section 12). */
export type PendingWrite = { seq: number; page: string; at: number };

/** A `(user, space)` runtime the server has used since its start; SilverBullet keeps it until restart. */
export type RuntimeInfo = {
  user: string;
  space: string;
  firstUsed: Date;
  lastUsed: Date;
  calls: number;
  reboots: number;
  /** The last pending write this runtime's index was seen to hold (or was rebooted for). */
  confirmedSeq: number;
};

/** How long a write stays pending for the index wait; later renders no longer check it. */
const PENDING_TTL = 10 * 60_000;
const PENDING_MAX = 1000;

export class State {
  readonly startedAt = new Date();
  readonly spaces = new Map<string, SpaceState>();
  allowlist: Check = { ok: false, problems: ["not loaded"] };
  fileTypes: Check = { ok: true, problems: [] };
  credentials: Check = { ok: false, problems: ["not loaded"] };
  accessList: Check = { ok: false, problems: ["not loaded"] };
  /** Settings weaker than the shipped defaults, reported once (docs/security.md, section 11). */
  relaxed: string[] = [];
  readonly requests = new Map<string, number>();
  readonly refusals = new Map<string, number>();
  readonly usersSeen = new Set<string>();
  readonly spacesSeen = new Set<string>();
  scanning = false;
  readonly reportPage: string;
  /** The technical user of the scan, named in the refusal of an unguarded space. */
  readonly scanUser: string;
  /** Writes through the server per space, for the index wait of the render tools. */
  readonly pendingWrites = new Map<string, PendingWrite[]>();
  private writeSeq = 0;
  /** The runtimes used since start, keyed `user/space`, for the report page. */
  readonly runtimes = new Map<string, RuntimeInfo>();

  constructor(reportPage: string, scanUser: string) {
    this.reportPage = reportPage;
    this.scanUser = scanUser;
  }

  space(name: string): SpaceState {
    let s = this.spaces.get(name);
    if (!s) {
      s = {
        space: name,
        guarded: false,
        unguardedReason: "not yet checked",
        transform: "unchecked",
        findings: [],
        files: [],
        quarantined: [],
        lastScan: null,
        scanMs: 0,
        pagesChecked: 0,
        filesSeen: 0,
        findingsChangedSinceScan: false,
      };
      this.spaces.set(name, s);
    }
    return s;
  }

  count(map: Map<string, number>, key: string) {
    map.set(key, (map.get(key) ?? 0) + 1);
  }

  /** After a write or delete of a page through the server: a render in that space first waits for the runtime's index. */
  recordWrite(space: string, page: string) {
    const now = Date.now();
    const list = (this.pendingWrites.get(space) ?? []).filter((w) => now - w.at < PENDING_TTL && w.page !== page);
    list.push({ seq: ++this.writeSeq, page, at: now });
    this.pendingWrites.set(space, list.slice(-PENDING_MAX));
  }

  /** The pending writes of a space that a runtime has not yet confirmed. */
  pendingFor(space: string, confirmedSeq: number): PendingWrite[] {
    const now = Date.now();
    return (this.pendingWrites.get(space) ?? []).filter((w) => w.seq > confirmedSeq && now - w.at < PENDING_TTL);
  }


  /** The predefined refuse-to-serve error for the whole server, or null. */
  globalRefusal(): string | null {
    if (!this.allowlist.ok) {
      return `Refusing to serve: the allowlist file is missing or invalid (${this.allowlist.problems.join("; ")}). Operator: fix the allowlist (docs/security.md, section 6) and restart the server or send it SIGHUP.`;
    }
    if (!this.fileTypes.ok) {
      return `Refusing to serve: the configured file types are invalid (${this.fileTypes.problems.join("; ")}). Operator: fix MCP_FILE_TYPES (docs/security.md, section 5) and restart the server.`;
    }
    if (!this.accessList.ok) {
      // A malformed line could be a denial; the list is applied whole or not at all.
      return `Refusing to serve: the access list file is missing or invalid (${this.accessList.problems.join("; ")}). Operator: fix the access list (docs/security.md, section 4) and restart the server or send it SIGHUP.`;
    }
    return null;
  }

  /** The predefined refuse-to-serve error for a space, or null when the space is served. */
  refusal(space: string | null): string | null {
    const global = this.globalRefusal();
    if (global) return global;
    if (space === null) return null;
    const s = this.spaces.get(space);
    if (!s || !s.guarded) {
      const why = s?.unguardedReason ?? "the server has not seen this space";
      return `Refusing to serve space "${space}": it is not guarded (${why}). Operator: make the technical user "${this.scanUser}" a write member of the space (docs/security.md, section 7); the server re-checks on the next scan or SIGHUP.`;
    }
    if (s.transform !== "present") {
      return `Refusing to serve space "${space}": the index-time transform is missing from CONFIG or differs from the shipped block. Operator: add the block of docs/security.md, section 10, to CONFIG verbatim and run "Space: Reindex" in every client; the server re-checks on the next scan or SIGHUP.`;
    }
    return null;
  }

  /** Why rendering is blocked in a space (docs/security.md, section 7), or null. Read by the render tools. */
  renderBlock(space: string): string | null {
    const s = this.spaces.get(space);
    if (!s) return null;
    const n = s.findings.length;
    const pages = new Set(s.findings.map((f) => f.page)).size;
    const m = s.files.length;
    if (n === 0 && m === 0) return null;
    const parts: string[] = [];
    if (n > 0) parts.push(`${n} finding(s) on ${pages} page(s) with code outside CONFIG and Library/`);
    if (m > 0) parts.push(`${m} file(s) that are not pages and are not on the allowed-files list`);
    return `Rendering is blocked in space "${space}": the last scan found ${parts.join(" and ")}. Operator: read the report page "${this.reportPage}" in that space, then fix or allow; agents may still read and write, and a cleaned page is accepted.`;
  }

  /** After a successful write or delete through the server: the page is clean or gone, so its findings go. */
  dropFindings(space: string, page: string, deletedFile?: string) {
    const s = this.spaces.get(space);
    if (!s) return;
    const before = s.findings.length + s.files.length;
    s.findings = s.findings.filter((f) => f.page !== page);
    if (deletedFile) s.files = s.files.filter((f) => f.file !== deletedFile);
    if (s.findings.length + s.files.length !== before) s.findingsChangedSinceScan = true;
  }
}
