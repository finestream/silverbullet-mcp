# silverbullet-mcp

An MCP server for a [SilverBullet](https://silverbullet.md) instance in multi-space mode: several users, each acting as themselves, every space they may reach, and pages rendered the way SilverBullet shows them.

**Status: architecture and security model proposed, no server yet.** The decision, the reasons and the spike measurements are in [docs/architecture.md](docs/architecture.md); the security model in [docs/security.md](docs/security.md).

## What is here

| Path | What |
|---|---|
| [`docs/architecture.md`](docs/architecture.md) | Architecture decision for v2 |
| [`docs/security.md`](docs/security.md) | Security model: threat model, access list, write filter, allowlist, scan, index-time transform, defaults |
| [`docs/space-guidelines.md`](docs/space-guidelines.md) | Conventions a space follows when this server guards it |
| [`docs/facts/`](docs/facts) | Measured behaviour of SilverBullet 2.12.1 that the security model rests on |
| [`test/compose.yaml`](test/compose.yaml) | Test instance: SilverBullet 2.12, two spaces, two users, bootstrapped through the admin API |
| [`spike/`](spike) | Throw-away scripts that tested the Runtime API (rendering, screenshots, isolation, memory); may be deleted later |

## Test instance

Requires Docker with Compose v2 and, for the spike scripts, Node.js ≥ 22.18.

```sh
docker compose -f test/compose.yaml run --rm bootstrap   # start and bootstrap SilverBullet on http://127.0.0.1:3300
node spike/render.ts                                      # rendering, isolation and screenshot checks
spike/measure-runtime.sh                                  # cold start and memory of a runtime
docker compose -f test/compose.yaml down -v               # remove everything
```

The bootstrap writes the users' API tokens to `test/.state/` (git-ignored).

## Licence

[MIT](LICENSE).

Code is taken only from MIT, Apache-2.0 or BSD-licensed projects and is credited here and in the file it lands in. Projects under copyleft or non-OSI licences are read for ideas only.

## Attributions

* [SilverBullet](https://github.com/silverbulletmd/silverbullet) (MIT): the API behaviour this server relies on was read from its source and documentation; the bootstrap sequence in `test/bootstrap/bootstrap.sh` follows its multi-space Runtime API end-to-end test. The write filter is built on four files of its Lua parser, copied unchanged (`lua.grammar`, `parse-lua.js`, `parse-lua.terms.js`, `lua_comment.js`, at tag 2.12.1) with SilverBullet's `LICENSE.md` beside them; see [docs/security.md](docs/security.md), section 5.
* [Ahmad-A0/silverbullet-mcp](https://github.com/Ahmad-A0/silverbullet-mcp) (MIT): the tool names, input schemas and the conditional `edit-note` logic (`prepareEdits`) are the model for v2's tools and will be copied, with attribution, when the server is implemented. No code copied yet.
* [xmatthewx/silverbullet-mcp-server](https://github.com/xmatthewx/silverbullet-mcp-server) (MIT): reviewed for its OAuth flow and tool surface. No code copied.
