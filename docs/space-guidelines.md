# Space guidelines

The conventions a space follows when this server guards it. They bind every writer, the operator included: the server enforces them for the users it serves ([security.md](security.md), sections 5, 7 and 10), and the rest of the space keeps to them by agreement.

SilverBullet runs code from any page, in the browser of whoever opens it and with that person's rights. A space where content and code mix cannot tell a page that *says* something from a page that *does* something. These guidelines separate the two by place, so that a page can be trusted by where it is.

## Rules

1. **Configuration lives only in `CONFIG`.** `CONFIG` is the trusted root of a space: everything in it is readable by every script that runs there. It holds no secret; a secret is held by the server that needs it.
2. **Code lives only in `Library/`:** Space Lua, Space Style, templates and functions. A Space Lua block anywhere else does not load (the index-time transform, [security.md](security.md), section 10).
3. **Every other page is data:** text, frontmatter, queries and calls to allowed functions. It defines no function, assigns nothing, and holds no `space-lua`, `space-config` or `space-style` block. There is no per-page exception.
4. **The rule is about place, not author.** A page outside `CONFIG` and `Library/` is held to rule 3 whoever wrote it.
5. **What a page may call is an allowlist,** kept outside the space and audited by the operator entry by entry ([security.md](security.md), section 6). A page that needs more (a configuration value, the list of scripts, a dynamic tag, the network) calls a function in `Library/` written for that purpose and put on the list after audit.
6. **Pages are the only files the server's users write.** Other file types are the operator's; a file that SilverBullet executes or serves as code (`*.plug.js`, `.html`, `.lua`) exists only where the operator put it on purpose.
7. **The space is written through SilverBullet and the MCP server only.** No sync client or other process writes to the space folder; version control and backups only read it.

Rule 7 is a strong recommendation rather than something the server can enforce. The scan and the index-time transform are built for a space that can still be written directly, but a direct write is the one route the write filter never sees: a block planted on disk is found at the next scan, not refused at once.

## What follows

* A page outside `Library/` can be rendered, transcluded or opened by anyone without running anything but audited code.
* The operator's pages follow rule 3 too: a page that reads configuration or scripts directly moves that into a Library function.
* The server refuses its users' pages that break rule 3, reports pages and files that break rules 3 and 6 on the report page, and keeps blocks outside `Library/` from loading.

## Alternatives considered

* **Code anywhere, as SilverBullet does by default.** Rejected: every reader of a page becomes an executor; a user's page runs with the reader's rights.
* **Rules by author** (some users' pages are data, the operator's may hold code). Rejected: nothing in the space can tell the author of a page reliably once a page has been edited by both, and a scan would have to guess.
* **Per-page exceptions** (a tag that allows code on one page). Rejected: the tag would be writable by whoever writes the page.
* **A deny list of dangerous functions** instead of an allowlist. Rejected: names can be built at run time; only an allowlist with a rule against dynamic calls holds.
