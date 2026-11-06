# Cloudflare Access

Status: **built, tested against a test team domain, and reached once through a real Access application** (2026-11-06): a hosted MCP client logged in through Managed OAuth, and its requests, through a Cloudflare Tunnel, were accepted as the user whose address the assertion carried. What rests on Cloudflare's documentation or on observation says so.

A third way in, beside static bearers and OAuth tokens ([oauth.md](oauth.md)), for a server that is published through [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/): Access logs the user in and lets a request through only then, and the server takes the user from the assertion Access adds to the request. With Access's [Managed OAuth](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/), Access is also the OAuth authorization server a hosted MCP client needs, so the server's own identity provider does not have to be reachable from the internet.

```
client ── OAuth (Managed OAuth) ──▶ Cloudflare Access: logs the user in, issues its own token
client ── Bearer <Access's token> ──▶ Cloudflare edge ══ tunnel ══▶ MCP server ── Bearer <that user's SilverBullet API token> ──▶ SilverBullet
                                       │                             │
                                       └─ adds the signed assertion  ├─ verifies: signature (team domain's keys), iss, aud = AUD tag, exp
                                          Cf-Access-Jwt-Assertion    └─ credentials file: the assertion's e-mail address → { user, sbToken, defaultSpace, groups }
```

## 1. What the server does

Off unless `MCP_CF_ACCESS_TEAM_DOMAIN` and `MCP_CF_ACCESS_AUD` are both set. With them:

* **A request with a `Cf-Access-Jwt-Assertion` header came through Access, and the assertion alone decides who it is.** A bearer on the same request is not looked at: a refused assertion is never rescued by another way in. A request without the header did not come through Access and is authenticated as before, by a static bearer or an OAuth token.
* **Verification** of every request's assertion, with [jose](https://github.com/panva/jose), as Cloudflare's [Validate JWTs](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/) asks:
  * the signature, with the team domain's keys from `https://<team domain>/cdn-cgi/access/certs`. Only `RS256` is accepted, which is what Access signs with;
  * `iss` equals the team domain, `https://<team>.cloudflareaccess.com`;
  * `aud` contains the application's AUD tag. An assertion for another application of the same team is refused;
  * `exp` is present and in the future, `nbf` if present in the past, with 30 seconds of tolerance.
* **The header alone proves nothing.** Whoever reaches the server by another route can send it; the signature is what counts, and the AUD tag is what ties it to this application. The server does not use `Cf-Access-Authenticated-User-Email` or any other unsigned header.
* **Keys.** Fetched at the first assertion, so the server starts without the team domain, and again when an assertion names an unknown key, at most every 30 seconds. Access rotates its keys every 6 weeks and keeps the previous one valid for 7 days (Cloudflare's documentation).
* **User.** The assertion's `email` claim selects the line of the credentials file that names that address in its sixth field ([`config/credentials.example`](../config/credentials.example)), in any case. A line may name several addresses; an address on two lines is a problem in the file, and the server refuses to serve until it is corrected. An address without a line gets `401`. An assertion without an address, which is what a [service token](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/) produces, selects nobody. The scan's technical user is never selected, whatever its line holds.
* **Two lists decide together.** The Access policy says which addresses may log in; the credentials file says which of them is a user of this server. An address that passes the policy and has no line gets nothing.
* **After that nothing differs.** The access list, the write filter, the scan state, the refusal to serve and the rate limit apply to the user as with any other way in ([security.md](security.md)).
* **What it answers on that route.** A refused assertion gets `401` with `WWW-Authenticate: Bearer realm="silverbullet-mcp", error="invalid_token"` and no `resource_metadata`: where a client of that route logs in is Access's to say (section 3). For the same reason the server's own Protected Resource Metadata answers `404` to a request that carries an assertion. The reason of a refusal goes to the log (`auth.refused`), never to the client, and never the assertion. With `MCP_LOG_LEVEL=debug`, an accepted assertion logs the names of its claims (`auth.access`), not their values.

| Variable | Default | What |
|---|---|---|
| `MCP_CF_ACCESS_TEAM_DOMAIN` | none | The team domain, `<team>.cloudflareaccess.com` (with or without `https://`) |
| `MCP_CF_ACCESS_AUD` | none | The *Application Audience (AUD) Tag* of the Access application in front of the server |

A setting that cannot be right stops the server at start.

## 2. What Access must do

1. **A self-hosted application** for the server's public host name, with **Managed OAuth** on if hosted MCP clients are to connect. Its AUD tag goes into `MCP_CF_ACCESS_AUD`.
2. **A policy that allows exactly the addresses that have a line** in the credentials file. One address per agent: the address is the agent's identity on this route, as its user name is on the others.
3. **A login method those addresses can complete.** With the one-time PIN, the address must receive mail; an agent's address can be forwarded to the person who sets its connector up.
4. **Allowed redirect URIs** for the clients, in the Managed OAuth settings. For Claude on the web, desktop and mobile: `https://claude.ai/api/mcp/auth_callback` ([Claude's connector documentation](https://claude.com/docs/connectors/building/authentication)).
5. **Short lifetimes.** The server cannot revoke an assertion: what bounds a leaked token is Access's token lifetime and session duration, and what ends a user's access is revoking the session in Access, the policy, or the address on the user's line.

### What an assertion carries

From Cloudflare's [Application token](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/application-token/) (read 2026-11-06):

| Claim | A user | A service token (as Cloudflare's example shows it) |
|---|---|---|
| `aud` | the application's AUD tag, as an array | the same |
| `iss` | the team domain | the same |
| `exp`, `iat` | expiry and issue time | the same |
| `email` | the address the identity provider verified | absent |
| `sub` | the user's ID in the Access organisation | empty |
| `type` | `app` | `app` |
| `nbf`, `identity_nonce`, `country` | present | absent |
| `common_name` | absent | the service token's client ID |
| `custom` | claims of the identity provider, if configured | absent |

The server reads `email` and nothing else of the payload.

**Observed for a Managed-OAuth request** (2026-11-06, a hosted MCP client logged in with a one-time PIN; names from the debug log, values not recorded): every claim of the user column, `email` included, plus three Cloudflare's page does not list: `oauth`, `policy_id` and `h_INTERNAL_DO_NOT_USE`. So an OAuth-authorised request does look like a browser-authenticated one to the origin, with a marker for the way it was authorised. The server ignores the three.

## 3. The route

* **Access answers what is not logged in.** Observed on an application with Managed OAuth (2026-11-06): a request without a valid token never reaches the origin. Access answers `401` with its own `WWW-Authenticate` naming `/.well-known/cloudflare-access-protected-resource/<path>`, and serves `/.well-known/oauth-protected-resource`, `/.well-known/oauth-protected-resource/<path>` and `/.well-known/oauth-authorization-server` on the application's host name itself, with the team domain as the authorization server. The server's own challenge and metadata are therefore never seen by a client of that route.
* **A host name served by Access sends every client to Access.** A client that is to log in at the OAuth issuer of [oauth.md](oauth.md), or to use a static bearer, must reach the server by a route that does not pass Access; `MCP_OAUTH_RESOURCE` is the URL of that route. The simple way is a host name of its own for the Access route.
* **Publish `/mcp` and nothing else.** With a [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/), the public host name's route can be limited to that path; `/healthz` and the OAuth metadata stay inside.
* **Let the tunnel require Access too.** The server takes a request without an assertion for one that did not come through Access. If the Access application were removed or bypassed while the tunnel stays, such requests would arrive from the internet and meet the bearer check alone. The tunnel's [*Protect with Access*](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/cloudflared-parameters/origin-parameters/) setting (`access.required`, with the team name and the AUD tag) makes `cloudflared` refuse them before the server sees them.
* **Refused requests of that route share one address.** The limit on refused requests is per connecting address, which through a tunnel is the connector; it slows guessing as a whole and never affects a request that is accepted.
* **Cloudflare sees the traffic.** Access and the tunnel terminate TLS at Cloudflare's edge: page contents pass through it in clear, which a direct route over a private network avoids.

## 4. Connecting a client

**Claude on the web, desktop and mobile:** *Settings → Connectors → Add custom connector*, with the public URL, path included (`https://mcp.example.org/mcp`). No client ID: the client registers itself with Access, within the allowed redirect URIs. *Connect* opens Access's login; log in with the address of the user the connector is to act as. An agent's connector is logged in as the agent's own address, not as the person who sets it up.

A client on the operator's own network keeps the direct route, with an OAuth token or a static bearer.

## 5. Tests

* `src/cf-access.test.ts`: the verifier alone, with a local key. Wrong audience, wrong issuer, expired, not yet valid, no expiry, another key, an unknown key, `alg: none`, an HMAC assertion keyed with the public key, another asymmetric algorithm; an assertion without an address; the configuration.
* `src/credentials.test.ts`: the sixth field, the look-up by address, an address on two lines.
* `test/server/06-cf-access.test.ts`: the server against the test instance and a test team domain, which is a local HTTP server that publishes keys at `/cdn-cgi/access/certs` and signs assertions. An assertion for A acts as A with A's access-list entries; every refusal with its logged reason and without a pointer to an authorization server; the assertion decides alone; static bearers and the OAuth challenge unchanged beside it; the header ignored without the settings; the team domain unreachable; a wrong configuration.
* Not tested here, because they need an Access application and a tunnel: a real client's login through Managed OAuth and its requests through the tunnel. Done once by hand on 2026-11-06 against a test application, with the server on a workstation and fixture pages (the status line and the observed claims above).
