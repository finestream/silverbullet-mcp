# The write filter

The write filter of the security model ([docs/security.md](../../docs/security.md), sections 5 and 6), built on SilverBullet's own Lua parser. The server runs it on every `create-note` and `edit-note` to a page outside `CONFIG` and `Library/` and in the scan; the unit test `filter.test.ts` and the release checks in `test/checks/05-parser.test.ts` run its matrix, `test/checks/06-cost.test.ts` times it. How it came to be is in [docs/facts/write-filter.md](../../docs/facts/write-filter.md).

* `filter.ts`: `checkPage(source, allowlist)` rejects `space-lua`, `space-config` and `space-style` fences; finds `${...}` directives the way SilverBullet's inline parser does; parses each body with SilverBullet's Lua parser and walks the tree: function definitions and assignments, references and calls not on the allowlist, calls whose root cannot be known statically, methods on values, queries without a named row, non-literal or script tag arguments, baked sections with code, and parse errors are all rejections. Each violation carries the rule, the line and the range in the page.
* `allowlist.ts`: the shipped allowlist, the never-allowed names, the file format and its validation.
* `cases.ts`: the matrix of 69 cases.
* `vendor/silverbullet/`: four files copied unchanged from [silverbulletmd/silverbullet](https://github.com/silverbulletmd/silverbullet) at tag `2.12.1`, MIT licence (`LICENSE.md` there): the Lua grammar (`lua.grammar`), the parser lezer-generator built from it (`parse-lua.js`, `parse-lua.terms.js`) and its comment tokenizer (`lua_comment.js`). The published npm package `@silverbulletmd/silverbullet` does not ship these files, which is why they are copied.

Dependencies: `@lezer/lr` and `@lezer/common` (the parser runtime), `@lezer/markdown` (fenced blocks and code spans), pinned in the root `package.json` to the versions SilverBullet 2.12.1 uses.
