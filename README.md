# silverbullet-mcp

An MCP server for a [SilverBullet](https://silverbullet.md) instance in multi-space mode: several users, each acting as themselves, every space they may reach, and pages rendered the way SilverBullet shows them.

## Goals

One MCP server for a whole SilverBullet instance that, beyond reading and writing pages:

1. serves **several users**, each with their own credential, and acts towards SilverBullet as *that* user, so that SilverBullet's permissions decide what is allowed and every write stays attributable to that user;
2. reaches **every space** of the instance that the user may access (SilverBullet ≥ 2.10 multi-space mode, spaces addressed as `/<space>`);
3. returns a page **rendered**, as Markdown with `${…}` expressions, queries, templates and transclusions evaluated, and as a **screenshot** (PNG), next to the raw source;
4. keeps the **revision-guarded `edit-note`** with `dryRun`, so that clients written for v1 keep working;
5. runs behind a reverse proxy with **secrets from files**, and can later verify **OAuth tokens** instead of static bearers;
6. **restricts each user further than SilverBullet does**, by path, with a deny-by-default access list per user and group that never widens what SilverBullet grants and applies to every tool, listings and search included;
7. **keeps code out of the pages agents write**, so that a page an agent wrote can be opened and rendered by any person without running anything but audited code;
8. is **MIT**, with code taken only from MIT, Apache or BSD sources.

It replaces a set-up of one single-user MCP server per user per space, called v1 in these documents ([Ahmad-A0/silverbullet-mcp](https://github.com/Ahmad-A0/silverbullet-mcp), one instance per identity): there, every additional identity costs one more container, and pages come back only as raw source, so queries do not show their results. How the server meets the goals is in [docs/architecture.md](docs/architecture.md).

## The security challenge

SilverBullet runs code from content: every Space Lua block and every `${…}` expression on any page runs in the browser of the person who opens the page, with that person's rights. An agent that can write one page can plant code that reads or writes everything, and a path-based access list does not close this: it decides where an agent may write, not what the written page may do. The server therefore keeps code out of the pages agents write and confines it to `Library/`, with configuration in `CONFIG`; the full model, and the terms *user*, *person*, *agent* and *operator* as these documents use them, are in [docs/security.md](docs/security.md).

## Posture

The server ships strict: a deny-by-default access list, a write filter on every write with an allowlist of the functions a page may call, a scan of the space in report-only mode, an index-time transform in `CONFIG` that keeps blocks outside `CONFIG` and `Library/` from loading, and a refusal to serve while any of these is missing or has findings. Every part but the last can be relaxed (write access to `Library/`, more allowlist entries, more file types, scan off or in quarantine mode), and the server reports a relaxed setting once at start, in its log and on its report page in the space ([docs/security.md](docs/security.md), section 11). The rules, the defaults that enforce them, and what relaxing each one accepts are in [docs/space-guidelines.md](docs/space-guidelines.md); how the controls work is in [docs/security.md](docs/security.md).

## Status

**Architectural blueprint, no server yet.** The architecture and the security model are proposed in `docs/`. Next is a test suite that checks, per SilverBullet release, the behaviour the design relies on (the *release checks*), then the server.

## What is here

| Path | What |
|---|---|
| [`docs/architecture.md`](docs/architecture.md) | Architecture decision for v2, with the measurements of the Runtime API spike |
| [`docs/security.md`](docs/security.md) | Security model: threat model, access list, write filter, allowlist, scan, index-time transform, defaults |
| [`docs/space-guidelines.md`](docs/space-guidelines.md) | Conventions a space follows when this server guards it |
| [`docs/facts/`](docs/facts) | Measured behaviour of SilverBullet 2.12.1 that the security model rests on |

The Runtime API spike, the write-filter spike and the compose test instance live on branches of their own until the release checks absorb them; the scripts behind the other facts were not kept.

## Licence

[MIT](LICENSE).

Code is taken only from MIT, Apache-2.0 or BSD-licensed projects and is credited here and in the file it lands in. Projects under copyleft or non-OSI licences are read for ideas only.

## Attributions

* [SilverBullet](https://github.com/silverbulletmd/silverbullet) (MIT): the API behaviour this server relies on was read from its source and documentation; the bootstrap of the test instance follows its multi-space Runtime API end-to-end test. The write filter will vendor four files of its Lua parser unchanged (`lua.grammar`, `parse-lua.js`, `parse-lua.terms.js`, `lua_comment.js`, at tag 2.12.1) with SilverBullet's `LICENSE.md` beside them, as the write-filter spike on its own branch already does; see [docs/security.md](docs/security.md), section 5.
* [Ahmad-A0/silverbullet-mcp](https://github.com/Ahmad-A0/silverbullet-mcp) (MIT): the tool names, input schemas and the conditional `edit-note` logic (`prepareEdits`) are the model for v2's tools and will be copied, with attribution, when the server is implemented. No code copied yet.
* [xmatthewx/silverbullet-mcp-server](https://github.com/xmatthewx/silverbullet-mcp-server) (MIT): reviewed for its OAuth flow and tool surface. No code copied.
