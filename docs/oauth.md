# OAuth

Status: **built and tested against a test issuer** (2026-11-06). Not yet run against a real identity provider or a real client; the sections that rest on vendor documentation say so.

The server can verify OAuth 2.1 access tokens beside the static bearers of phase 1 ([architecture.md](architecture.md), section 2). It is a **resource server only**: an external authorization server (an OpenID Connect provider such as Keycloak) logs the user in and issues the token, the MCP server checks it and looks the user up in its credentials file. It runs no authorization server, stores no token and forwards none.

```
client ── authorization code + PKCE ──▶ authorization server (issuer)
client ── Bearer <access token> ──▶ MCP server ── Bearer <that user's SilverBullet API token> ──▶ SilverBullet
                                     │
                                     ├─ verifies: signature (issuer's JWKS), iss, aud = resource, exp
                                     └─ credentials file: the token's user claim → { user, sbToken, defaultSpace, groups }
```

## 1. What the server does

Off unless `MCP_OAUTH_ISSUER` and `MCP_OAUTH_RESOURCE` are both set. With them:

* **Metadata.** `GET /.well-known/oauth-protected-resource/mcp` and `GET /.well-known/oauth-protected-resource` answer the Protected Resource Metadata of [RFC 9728](https://www.rfc-editor.org/rfc/rfc9728): the resource, the issuer as the only authorization server, the bearer method `header`, and the scopes if any are required. It is public by design and says nothing about users or spaces.
* **Challenge.** A request to `/mcp` without a valid bearer gets `401` with `WWW-Authenticate: Bearer realm="silverbullet-mcp", resource_metadata="…"`, and `error="invalid_token"` when a token was sent and refused. A token without a required scope gets `403` with `error="insufficient_scope"`. The reason goes to the log, never to the client, and never the token.
* **Verification** of every request's token, with [jose](https://github.com/panva/jose):
  * the signature, with the issuer's keys. Only asymmetric algorithms are accepted; an unsigned token or one signed with an HMAC algorithm cannot pass;
  * `iss` equals `MCP_OAUTH_ISSUER`;
  * `aud` contains `MCP_OAUTH_RESOURCE`, exactly as written ([RFC 8707](https://www.rfc-editor.org/rfc/rfc8707)). A token issued for another service of the same issuer, or an ID token, is refused: this is what keeps the server from being a confused deputy;
  * `exp` is present and in the future, `nbf` if present in the past, with 30 seconds of tolerance;
  * every scope of `MCP_OAUTH_SCOPES` is in `scope`.
* **Keys.** From `MCP_OAUTH_JWKS_URL`, or from the `jwks_uri` of the issuer's metadata, which is looked for where MCP clients look (RFC 8414 with the issuer's path appended, then the two OpenID Connect forms) and accepted only if it names the configured issuer. The look-up happens at the first token, so the server starts without the issuer; while the issuer cannot be reached, tokens get `401` and static bearers keep working. Keys are cached and fetched again when a token names an unknown key, at most every 30 seconds.
* **User.** The claim `preferred_username` (or the one named by `MCP_OAUTH_USER_CLAIM`) selects the user's line in the credentials file: exactly, or, when no line has that name, the only line that has it in another case, because an identity provider may fold user names to lower case. Two lines that differ only in case are not guessed between. A name without a line gets `401`. The scan's technical user has no client and is never selected.
* **After that nothing differs.** The access list, the write filter, the scan state and the refusal to serve apply to the user as they do with a static bearer ([security.md](security.md)). The rate limit is per user, whichever way the user came in.
* **Static bearers stay**, for local clients without OAuth. A bearer is first looked up by its hash, then verified as a token.

| Variable | Default | What |
|---|---|---|
| `MCP_OAUTH_ISSUER` | none | The issuer identifier, as the tokens carry it in `iss`, for example `https://login.example.org/realms/main` |
| `MCP_OAUTH_RESOURCE` | none | This server's URL as the clients enter it, path included, for example `https://mcp.example.org/mcp` |
| `MCP_OAUTH_JWKS_URL` | from the issuer's metadata | Where the issuer's keys are, when the server should reach them by another name than the public one |
| `MCP_OAUTH_USER_CLAIM` | `preferred_username` | The claim that names the user's line in the credentials file |
| `MCP_OAUTH_SCOPES` | none | Scopes every token must carry, space- or comma-separated; advertised in the metadata and the challenge |

The URLs must be `https`; `http` is accepted for a loopback address only. A setting that cannot be right stops the server at start.

## 2. What the authorization server must do

Whatever the product:

1. **Put the resource into `aud`.** The access token's audience must contain the value of `MCP_OAUTH_RESOURCE`. This is the one setting the server cannot do without.
2. **Carry the user's name** in `preferred_username` (or the configured claim), equal to the user's name in the credentials file, in any case.
3. **Sign with an asymmetric key** and publish it as a JWKS, named in its metadata.
4. **Publish its metadata** (RFC 8414 or OpenID Connect Discovery) with `code_challenge_methods_supported` containing `S256`: MCP clients use the authorization code flow with PKCE.
5. **Know the client**, in one of the ways of section 3.
6. **Be reachable by the client and by the MCP server.** A client that runs on the user's machine needs to reach both from there. A hosted client reaches both from its vendor's network (section 4).

### Keycloak

From Keycloak's guide [Integrating with Model Context Protocol](https://www.keycloak.org/securing-apps/mcp-authz-server), read for 26.8; not yet tried here.

* **Issuer:** `https://<host>/realms/<realm>`. The metadata is at `/realms/<realm>/.well-known/openid-configuration`, the third place the server looks.
* **Audience.** Keycloak ignores the `resource` parameter unless the experimental feature `resource-indicators` is on. Without it, the guide's way is a **client scope** (for example `mcp:tools`) with a mapper of type *Audience* whose *Included Custom Audience* is the resource URL. The scope must reach the token: either it is a *default* scope of the client, or it is *optional* and the client asks for it, which a client does when the MCP server advertises it (`MCP_OAUTH_SCOPES=mcp:tools`).
* **User names.** Keycloak folds user names to lower case; the server's user look-up allows for that (section 1).
* **Token lifetime** is the realm's or the client's *Access Token Lifespan*. The MCP server cannot revoke a token; a short lifetime and a refresh token are what bound a leaked one.

## 3. Client registration

The authorization server must know the client that asks for a token. MCP offers three ways. The MCP server takes no part in any of them, so the choice is the operator's and can change later without a new release.

| Way | What it needs from the authorization server | For | Against |
|---|---|---|---|
| **A client registered by hand** | One public client with PKCE (`S256`) required and the clients' redirect URIs; the client ID is entered in each MCP client | Nothing registers itself. The redirect URIs are a fixed, short list. No experimental feature. One place to revoke | Each MCP client must be told the client ID |
| **Dynamic Client Registration** ([RFC 7591](https://www.rfc-editor.org/rfc/rfc7591)) | An open registration endpoint, restricted by policy: trusted hosts, allowed scopes, allowed redirect URIs | Clients connect by URL alone | Anyone who reaches the endpoint within the policy creates a client. Each new connection may register a new client, so they accumulate |
| **Client ID Metadata Documents** | The authorization server fetches the client's metadata from the URL that is its client ID, restricted to trusted domains | Clients connect by URL alone, nothing accumulates | Experimental in Keycloak 26.8 (`--features=cimd`), and its guide says it may change incompatibly |

**Recommendation for one person or a small team: a client registered by hand.** It is the smallest surface on an identity provider that also guards other services, and it rests on nothing experimental. Dynamic registration is the fallback where a client cannot be given a client ID.

What the clients need, from [Claude's connector documentation](https://claude.com/docs/connectors/building/authentication) (read 2026-11-06, not yet tried here):

| Client | Redirect URI to allow | How it gets the client ID |
|---|---|---|
| Claude on the web, desktop and mobile (custom connector) | `https://claude.ai/api/mcp/auth_callback` | Entered with the connector, or by one of the two automatic ways |
| Claude Code | `http://localhost:<port>/callback` and `http://127.0.0.1:<port>/callback`; the port changes per session unless fixed | `--client-id`, with `--callback-port` to fix the port |

## 4. Reachability

* **A client on the user's own machine** (Claude Code) connects from that machine, and its browser does the login. If the machine reaches the MCP server and the issuer, for example over a private network, nothing needs to be public.
* **A hosted client** (a custom connector of Claude on the web, desktop or mobile) connects from its vendor's network: the vendor's servers call the MCP server and fetch the issuer's metadata and token endpoint. Both must then be reachable from there. Claude's documentation names the range its requests come from; an operator can admit that range alone.
* **Only the MCP server and the issuer's OAuth endpoints** need to be reachable, never SilverBullet. The MCP server needs `/mcp`, `/.well-known/oauth-protected-resource` and nothing else from outside; `/healthz` can stay inside.
* Once the server is reachable from outside, **the token is the only thing between the internet and the tools**. Keep the access list as narrow as before, keep the rate limits, and watch `auth.refused` in the log.

## 5. Connecting a client

The server's URL is the value of `MCP_OAUTH_RESOURCE`, entered exactly, path included.

**Claude Code**

```sh
claude mcp add --scope user --transport http notes https://mcp.example.org/mcp --client-id <client id> --callback-port 8765
```

Then `/mcp` in a session, choose the server and *Authenticate*: the browser opens the issuer's login. With a client registered by hand, `http://localhost:8765/callback` and `http://127.0.0.1:8765/callback` are the redirect URIs to allow (section 3). Without `--client-id` the client registers itself, where the authorization server lets it.

**Claude on the web, desktop and mobile**

*Settings → Connectors → Add custom connector*, the server's URL, and the client ID in the connector's OAuth settings if one was registered by hand. *Connect* opens the issuer's login.

**What a login looks like.** The client asks the MCP server, gets `401` with the metadata URL, reads the issuer from it, sends the user's browser to the issuer, and comes back with a code that it exchanges for a token. The user logs in as the user whose name is in the credentials file. An agent's connector is logged in as the agent's own user, not as the person who sets it up.

**No `mcp-remote`.** A client that connects this way speaks HTTP itself, so the bridge and the static bearer of that client can go: delete the bearer's hash from the user's line.

## 6. Tests

* `src/oauth.test.ts`: the verifier alone, with a local key. Wrong audience, wrong issuer, expired, not yet valid, no expiry, another key, an unknown key, `alg: none`, an HMAC token keyed with the public key; scopes; the user claim; the metadata and the challenge; the configuration; the user look-up.
* `test/server/05-oauth.test.ts`: the server against the test instance and a test issuer, which is a local HTTP server that publishes OpenID Connect discovery and a JWKS and signs tokens. The metadata, checked with the MCP SDK's own client code; the challenge; a token for user A acts as A with A's access-list entries; every refusal with its logged reason; static bearers beside OAuth; scopes; the issuer unreachable; a wrong configuration.
* Not tested here: a real authorization server, a real client's login, and reachability from outside. They need the deployment.
