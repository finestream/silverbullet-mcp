# Facts: the index-time transform for `space-lua`

Consumers of `space-lua` objects, whether `CONFIG`'s own objects can be dropped, survival across reloads and a browser boot, and timing hazards. A follow-up to [execution-model.md](execution-model.md), section 6 (test G). Source at tag `2.12.1`, paths relative to the repository root. Tests ran on the same local instance, as a write member of a test space, through `POST /<space>/.runtime/lua_script` (labels `P…`, `B-P…`) and, for the browser, through Playwright with a fresh Chromium profile logged in as that member (labels `B1…`, `browser`), reading the client through `globalThis.client` (`client/boot.ts:279`).

**Two transforms were tested.** *A* returns `{}` for objects outside `CONFIG` and `Library/`, the form the documentation suggests for "do not index". *B* keeps the object and empties its code. A has a defect that changes the picture (section 4); the facts below say which variant they were measured with.

```lua
-- Variant A. DEFECTIVE: see section 4.
local function confine(o)
  local page = string.match(o.ref, "^(.*)@%d+$") or ""
  if page == "CONFIG" or string.startsWith(page, "Library/") then return o end
  return {}
end
tag.define { name = "space-lua", transform = confine }
tag.define { name = "space-style", transform = confine }
```

```lua
-- Variant B: the object stays in the index, its code is replaced. This is the shipped block.
local function confine(o)
  local page = string.match(o.ref, "^(.*)@%d+$") or ""
  if page == "CONFIG" or string.startsWith(page, "Library/") then return o end
  if o.script then o.script = "-- not loaded: outside CONFIG and Library/" end
  if o.style then o.style = "/* not loaded: outside CONFIG and Library/ */" end
  return o
end
tag.define { name = "space-lua", transform = confine }
tag.define { name = "space-style", transform = confine }
```

Both sat in `CONFIG`'s `space-lua` block after `config.set("agentTest.secret", "CONFIG-SECRET-4711")`.

## 1. Who reads `space-lua` and `space-style` objects

**Answer.** Besides the script loader and the style injection, one page: `Library/Std/Pages/Space Overview` lists the scripts in load order and the styles. No plug, no UI element, no command-palette entry and no other Std page reads them. What the client does with them is text-based or follows from loading, not from the index.

Evidence (grep over `client/`, `plugs/`, `plug-api/`, `libraries/`, `docs/` for `"space-lua"`, `"space-style"`, `index.objects("space-lua")`, `tags.space-lua`):

* Loader: `client/space_lua.ts:60-75` (`queryLuaObjects(… "space-lua" …)`), style injection `client/client.ts:1256-1277`.
* `libraries/Library/Std/Pages/Space Overview.md:17-31`: *Active Space Lua* (`from script = index.objects("space-lua") order by priority desc, ref`) and *Active Space Style* (`index.objects("space-style")`). With variant A the outside scripts vanish from the list; with B they appear with the replacement text as their source, which makes the policy visible. Nothing breaks.
* Not consumers, text-based: the lint of `space-lua` fences in the open page (`plugs/index/lint.ts:155-171`, parses the page text); completion and "go to definition" (`plugs/editor/lua.ts:40-60`, `client/space_lua.ts:155-200`, from the parse tree and from loaded functions' refs); the quarantine reconcile (`client/space_lua.ts:80`, refs of the loaded list); the slash templates that insert a `space-lua` fence (`libraries/Library/Std/Slash Templates/*.md`, `Slash.md:63`). The quarantine notification counts quarantined refs, which only ever come from loaded scripts.
* Docs that show the query: `docs/Space Lua.md:56`, `docs/Space Style.md:41`, `docs/API.md:20` (that one queries pages tagged `api/space-lua`, unrelated).
* Indexer side: `plugs/index/indexer.ts:38-51` treats the two tags specially (no anchor records, inert inside comments); not a reader.

## 2. Can `CONFIG`'s own objects be dropped too?

**Answer.** No, not with this mechanism. The transform itself still acts on the initial index when it lives in `CONFIG`, but everything else `CONFIG` does is lost after the first script reload, because the loader clears the configuration and rebuilds it from the index, and `CONFIG`'s block is no longer there.

Evidence, test P2 (variant A extended to drop `CONFIG@…` as well, keeping `Library/…` only; `CONFIG` also held `tag.define { name = "thing", schema = … }`, `command.define { name = "AgentTest: Ping", … }`, `event.listen { name = "agentTest:ping", … }` and `function cfgfn() return #space.readPage("index") end`):

* P2-3, fresh runtime (same as a browser boot): `index.tag "space-lua"` has no `CONFIG@…` and no outside object (the transform acted). But `config.get("agentTest.secret")` is nil; `tags.thing`, the command, the event handler, `cfgfn`: all nil. `mylib_fn` from `Library/Mine`: defined.
* Why: `client/client_system.ts:283-287`: `loadLuaScriptsImpl` does `this.client.config.clear()` (`client/config.ts:87-94`: values, schemas and categories emptied) and then `spaceLuaEnv.reload()`, which runs only what the index holds (`client/space_lua.ts:60-75`). The boot pass (`client/boot.ts:84-93, 117-121`) runs `CONFIG` once before the client exists; its results are the configuration the index pass uses, and they are gone at the first `loadLuaScripts` (boot: `client/client.ts:389-391`, then again after the initial index via `editor:reloadState`, `client/data/object_index.ts:159`).
* P2-2 shows the inverse: `index.reindexSpace()` while the transform was not in the configuration brought `CONFIG@14` and the outside object back, and the next `loadScripts` ran them (secret, tag, command defined again).

**What the boot pass offers** (`client/boot_config.ts:50-100`, inputs `client/boot.ts:87-93`): the Lua standard library (`luaBuildStandardEnv`) plus the syscalls `config.*` (get, set, insert, has, define, defineCategory, getValues, getSchemas, getCategories), `system.*`, `editor.*`, `markdown.*`, `language.*`, `jsonschema.*` (`client/plugos/syscalls/*`); and, run before `CONFIG` in the same environment, the `space-lua` blocks of `Library/Std/APIs/Schema.md`, `Library/Std/Config.md` and `Library/Std/APIs/Tag.md`, so `schema.*`, `config.define…` and `tag.define` exist there. That is why the transform works from the boot pass: `tag.define` is `config.set({"tags", name}, …)` (`Library/Std/APIs/Tag.md:33-50`). **Not available:** `space.*`, `index.*`, `template.*`, `command.*`, `event.*`, `net.*`, `shell.*`, `js`, and the `query` over the index. A statement that uses them errors; the error is logged and ignored ("extremely liberal in ignoring errors", `client/boot_config.ts:93-103`). `editor.*` calls are late-bound through a proxy and only make sense for things like `editor.isMobile()`.

## 3. Does the transform survive reloads and a browser boot?

**Answer.** Yes, all four, with both variants. The transform is a value in the configuration (`config.tags["space-lua"]`), re-set by `CONFIG`'s block on every script load, and read by the indexer at index time (`client/data/object_index.ts:883-886`).

| Operation | Variant A | Variant B | Seen |
|---|---|---|---|
| `system.loadScripts()` (what `System: Reload` ran before 2.12; today the command runs `system.reboot`, `plugs/editor/editor.test.ts:35-42`) | P3-a | B-P3-a | transform stored, no outside script loaded, `mylib_fn` loaded, secret set |
| `system.reboot()` | P3-b | B-P3-b | same |
| `index.reindexSpace()` then `loadScripts` | P3-c (3 s), P4-f (10 s) | B-P3-c (8 s) | same; variant B: 9 outside objects, all with the replacement text, 9 `External…` pages indexed |
| Fresh headless runtime (boot) | P3-0, G3 | B-P3-0 | same |
| Browser boot, fresh profile, service worker and IndexedDB | `browser boot` | B1 | A: `outside: []`, `ext: nil`, `lib: defined`, secret set, 51 scripts loaded in 52 ms. B: 59 scripts, outside ones emptied, `ext: []`, secret set |

## 4. Timing hazards

**Answer.** The transform runs inside the index write, before anything is stored (`client/data/object_index.ts:897-993`: transforms first, key-value records emitted after), so an outside object never reaches the index with its code, and a reload that follows an incremental index has nothing to load. Confirmed in the browser with variant B: an externally written page with a `space-lua` block was indexed after 0.5 s with its script already replaced; `loadLuaScripts()` afterwards defined nothing (B2, B3). Three hazards remain, two of them real:

1. **Variant A removes the whole page from the index.** `return {}` in Lua reaches the indexer as a JS object, not an empty array (`client/space_lua/runtime.ts:1206-1211`: an empty table converts to an object), so `newObjects` becomes `[{}]`, "transform result object did not contain ref" and `transform() result objects for space-lua did not contain result with original ref.` are thrown (`object_index.ts:964-989`), `index.indexPage` fails for that page and **no object of it is stored**: no page object, no links, no tasks. Browser console during the incremental index of `External8`: the two errors above (test browser3). State: 65 pages indexed, none of the nine `External…` pages; the "outside = 0" results of [execution-model.md](execution-model.md), test G, and of P3/P4 here were partly this. The docs say `{}` means "not indexed" (`docs/API/tag.md:59`); the code wants an empty array. Variant B has no such effect (B1–B3: pages indexed, links kept).
2. **An index built while the transform was absent keeps its objects, and later reloads run them.** P4-c: `CONFIG` without the transform, `loadScripts`, `reindexSpace`: three outside objects in the index. P4-d: transform put back, `loadScripts` without reindex: `ext_marker`, `ext3_marker` defined (the scripts ran), index unchanged. P4-e/f: `reindexSpace` then `loadScripts`: objects gone, functions gone. So: adding the transform to an existing space needs a `Space: Reindex` in every client (each browser has its own index), and the transform's absence at any reindex is a hole until the next reindex.
3. **The `config.clear()` window.** `loadLuaScriptsImpl` clears the configuration and then re-runs the scripts (`client/client_system.ts:283-287`); a page indexed in that window is processed without the transform. Scripts load in 35–80 ms here (browser console), so the window is short; not reproduced.

Order on a reload after an incremental index: the index write (with transform) completes before `loadLuaScripts` queries the index; there is no path where an object is loaded first and transformed later (`space_lua.ts:60-75` reads only stored objects).

## Open points and surprises

* The headless runtime client did not index externally written pages in the tests of this page (P4-a, P4-h, P4-c with API and disk writes: never within 20–30 s), although the server's `/.events` stream delivered the change events; the browser client indexed the same kind of write in 0.5 s, and the runtime in the tests of [execution-model.md](execution-model.md) (section 4) did in 0.6 s. Not explained; it affects the render path (a fresh runtime indexes everything at boot; a long-lived one may lag), which is why a render after a write waits for the index and falls back to a fresh runtime ([security.md](../security.md), section 12).
* `index.reindexSpace()` from Lua returns before the rebuild is complete, and `loadLuaScripts` skips while the index is unavailable (`object_index.ts:561-563`, `client_system.ts:277-282`): a `loadScripts` right after a reindex is a no-op (P4-c3, P4-e), the next one applies (P4-f).
* With variant B the Space Overview lists outside scripts with the replacement text; with A they are absent and so is the page itself.
* `space-lua` objects of pages outside the policy still exist with variant B (empty), so `index.tag "space-lua"` shows that a page carries a block, not what it says. `CONFIG`'s source stays readable (section 2).
* Not tested: a `space-style` block outside the policy with variant B (the `style` field is replaced the same way; the injection path `client.ts:1256-1277` would inject the comment).
