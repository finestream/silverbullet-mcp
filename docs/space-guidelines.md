# Space guidelines

The rules a space follows when this server guards it, the defaults that enforce them, and what it costs to relax each one.

These rules are **opinionated**. SilverBullet lets any page carry code and runs it in the browser of whoever opens the page, with that reader's rights; a space where content and code mix cannot tell a page that *says* something from a page that *does* something. The rules below trade that freedom for one property: a page can be trusted by where it is. They bind every writer, the operator included.

They are **on by default**: the server ships with them enforced by its five controls, the access list, the write filter with its allowlist, the scan, the index-time transform and the refusal to serve ([security.md](security.md), section 2). Each default can be **overridden** in the server's configuration, by the operator, by accepting the risk named next to it. The server accepts the weaker setting, says so once at start and on its report page ([security.md](security.md), sections 8 and 11), and keeps running. Two things cannot be switched off: the never-allowed names of the allowlist ([security.md](security.md), section 6) and the check that the transform is in `CONFIG`.

## Rules and what they imply

1. **Configuration lives only in `CONFIG`.** `CONFIG` is the trusted root of a space: everything in it is readable by every script that runs there, and its source stays queryable from the index. *Implication:* `CONFIG` holds no secret; a secret is held by the server that needs it.
2. **Code lives only in `Library/`:** Space Lua, Space Style, templates and functions. `CONFIG` holds configuration code only: settings and the transform block of the server. *Implication:* a Space Lua or Space Style block anywhere else does not load, in any client; it stays visible as text, with a comment in its place in the Space Overview.
3. **Every other page is data:** text, frontmatter, queries and calls to allowed functions. It defines no function, assigns nothing, and holds no `space-lua`, `space-config` or `space-style` block. *Implication:* a page copied in from another space may be refused for a block that would have been inert anyway; the error names the line, and the fix is to fence it as `lua` or to move it to `Library/`.
4. **The rule is about place, not author.** A page outside `CONFIG` and `Library/` is held to rule 3 whoever wrote it. *Implication:* the operator's own pages follow rule 3 too; a page that reads configuration or scripts directly moves that into a Library function. There is no per-page exception: a tag that allowed code on one page would be writable by whoever writes the page.
5. **What a page may call is an allowlist,** kept outside the space and audited by the operator entry by entry. *Implication:* a page that needs more (a configuration value, the list of scripts, a dynamic tag, the network) calls a function in `Library/` written for that purpose and put on the list after audit; that function treats what it receives as data. A method on a value is written as a function call (`string.upper(x)`), because the filter cannot know the value's type.
6. **Pages are the only files the server's users write.** Other file types are the operator's; a file that SilverBullet executes or serves as code (`*.plug.js`, `.html`, `.lua`) exists only where the operator put it on purpose. *Implication:* such a file found by the scan is reported, never changed; the operator removes it or allows it by path.
7. **The space is written through SilverBullet and the MCP server only.** No sync client or other process writes to the space folder; version control and backups only read it. *Implication:* this is the one rule the server cannot enforce. A page written directly bypasses the write filter; its blocks are kept from loading by the transform, its expressions run until the next scan finds them.

## Defaults and overrides

| Default | What it protects | Override | Risk accepted |
|---|---|---|---|
| Access list deny by default; the group `agents` has `r` on the space and `-` on `CONFIG`, `SETTINGS` and `Library/` | The places that hold code are written only by the operator; a user sees and touches only what the operator granted | Grant `w` on `Library/`, or `rw` where the operator chooses | A user with `w` on `Library/` writes code that loads in every client with every reader's rights; the write filter does not apply there, because `Library/` is where code belongs |
| Write filter on every write, with the shipped allowlist (`query`, `template.*`, `templates.*`, `index.*`, `views.*`, `string.*`) | A page written through the server holds no code and calls only audited functions | Add entries, as `name`, `name.*` or `*.method` | Every entry is code a page may run with the reader's rights; an entry that evaluates its input, reads a page named by its argument or reaches the network is the same hole one level up. `*.method` entries allow that method on values of any type |
| File types `.md` only | Nothing but pages is written through the server; types that execute or are served as code never are | Add types (for example `.png`, `.csv`) | Larger surface for what arrives through the server; a type SilverBullet executes or serves as code cannot be added at all |
| Scan on, on a schedule shorter than a browser session | Code that arrived by any route is found within one interval, and the server refuses to serve until the operator has looked | Scan off | Code written directly to the space stays until someone notices; the server serves a space that may hold code |
| Scan in report-only mode | No page but the report page is ever changed by the server | Quarantine mode | The scan edits pages: a fence becomes a `lua` fence, an expression is wrapped in backticks, the page is tagged. Reversible by hand only; a page the operator was editing may change under them |
| Transform block in `CONFIG`, checked at start | A block outside `CONFIG` and `Library/` never loads, whatever route it took | None; the check cannot be switched off | — |
| Never-allowed names on the allowlist | A configuration mistake cannot admit `space.*`, `config.*`, the loaders, the metatable functions or the registries | None | — |

## Alternatives considered

* **Code anywhere, as SilverBullet does by default.** Rejected: every reader of a page becomes an executor; a user's page runs with the reader's rights.
* **Rules by author** (some users' pages are data, the operator's may hold code). Rejected: nothing in the space can tell the author of a page reliably once a page has been edited by both, and a scan would have to guess.
* **Per-page exceptions** (a tag that allows code on one page). Rejected: the tag would be writable by whoever writes the page.
* **A deny list of dangerous functions** instead of an allowlist. Rejected: names can be built at run time; only an allowlist with a rule against dynamic calls holds.
