# Facts

Measured behaviour of SilverBullet **2.12.1** that the [security model](../security.md) rests on. These are observations, not decisions: each page says what was tested, how, and what the source says. Source references are `path:line` at tag `2.12.1` of [silverbulletmd/silverbullet](https://github.com/silverbulletmd/silverbullet), relative to its repository root.

| Page | Question |
|---|---|
| [execution-model.md](execution-model.md) | Which blocks execute, where expressions are evaluated, what runs outside `.md`, how external edits arrive, what the index exposes, what restricts code to a place |
| [index-transform.md](index-transform.md) | The index-time transform: who reads `space-lua` objects, whether `CONFIG`'s own objects can be dropped, survival across reloads, timing hazards, why the `return {}` variant is defective |
| [write-filter.md](write-filter.md) | Reusing SilverBullet's Lua parser for the write filter: what can be imported, the rules, the test matrix, the cost |

Tests ran on a local 2.12.1 instance (native server binary on Apple silicon, Chromium for the Runtime API, Node 26). Test labels (`A1`, `B`, `P3-c`, …) refer to those runs; the test scripts were throw-away and are not part of the repository, but the queries and scripts that matter are quoted.
