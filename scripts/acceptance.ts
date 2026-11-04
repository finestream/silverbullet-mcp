// Acceptance test of a running server, from any machine that reaches it
// (README, "Acceptance test"). It speaks MCP over streamable HTTP as one
// user, checks every control once, writes only under one folder of its own
// and removes what it created where it may. Settings come from the
// environment; nothing is read from a file. Exit code 1 if a check fails.
//
//   MCP_URL=https://mcp.example.org/mcp MCP_BEARER=… node scripts/acceptance.ts

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const env = (name: string, fallback?: string): string => {
  const v = process.env[name];
  if (v !== undefined && v !== "") return v;
  if (fallback !== undefined) return fallback;
  console.error(`${name} is required`);
  process.exit(2);
};

const URL_ = env("MCP_URL");
const BEARER = env("MCP_BEARER");
const SPACE = process.env.MCP_SPACE || undefined; // default: the user's default space
const RAW_PAGE = env("MCP_RAW_PAGE", "index"); // a page with queries; read raw, then rendered
const SCREENSHOT_PAGE = env("MCP_SCREENSHOT_PAGE", RAW_PAGE);
const DENIED_PAGE = env("MCP_DENIED_PAGE", "CONFIG"); // must be absent from listings and search
const DENIED_TEXT = env("MCP_DENIED_TEXT", "space-lua"); // a text the denied page holds
const WRITE_AREA = env("MCP_WRITE_AREA", "Agent/"); // where this user may create and edit (and delete, for the clean-up)
const OUTSIDE_PAGE = env("MCP_OUTSIDE_PAGE", "Acceptance outside"); // a page name where the user has no w
const REPORT_PAGE = env("MCP_REPORT_PAGE", "MCP Server");
const EXPECT_RENDER = env("MCP_EXPECT_RENDER", "no") === "yes"; // whether the access list grants x

type Result = { text: string; data: Record<string, any> | undefined; isError: boolean; image?: { data: string; mimeType: string } };

let failures = 0;
const pass = (what: string, detail = "") => console.log(`PASS  ${what}${detail ? `  (${detail})` : ""}`);
const fail = (what: string, detail: string) => { failures++; console.log(`FAIL  ${what}\n      ${detail.replace(/\n/g, "\n      ")}`); };
const check = (ok: boolean, what: string, detail: string) => (ok ? pass(what, detail.split("\n")[0].slice(0, 160)) : fail(what, detail));
const first = (s: string, n = 300) => s.replace(/\s+/g, " ").slice(0, n);

async function main() {
  const base = new URL(URL_);
  console.log(`Acceptance test of ${base.origin}${base.pathname}${SPACE ? `, space ${SPACE}` : ", the user's default space"}; rendering expected: ${EXPECT_RENDER ? "yes" : "no"}\n`);

  // 1. A wrong bearer is refused with 401 before anything else happens.
  const wrong = await fetch(URL_, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: "Bearer not-a-valid-bearer" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
  check(wrong.status === 401, "wrong bearer -> 401", `status ${wrong.status}, WWW-Authenticate: ${wrong.headers.get("www-authenticate") ?? "none"}`);
  const health = await fetch(new URL("/healthz", URL_));
  check(health.status === 200, "/healthz -> 200 (serving)", `status ${health.status}: ${first(await health.text())}`);

  const client = new Client({ name: "acceptance", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(URL_), { requestInit: { headers: { Authorization: `Bearer ${BEARER}` } } }));
  const call = async (tool: string, args: Record<string, unknown> = {}): Promise<Result> => {
    const r = (await client.callTool({ name: tool, arguments: SPACE ? { space: SPACE, ...args } : args })) as { content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>; structuredContent?: Record<string, any>; isError?: boolean };
    const image = r.content.find((c) => c.type === "image");
    return { text: r.content.filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n"), data: r.structuredContent, isError: r.isError === true, image: image ? { data: image.data!, mimeType: image.mimeType! } : undefined };
  };

  // 2. The user's spaces with the effective rights.
  const spaces = await call("list-spaces");
  check(!spaces.isError && (spaces.data?.spaces?.length ?? 0) > 0, "list-spaces: spaces with effective rights", spaces.text);
  const space: string = SPACE ?? spaces.data?.defaultSpace;
  const here = (spaces.data?.spaces as Array<Record<string, any>> | undefined)?.find((s) => s.space === space);
  if (here?.refusal) fail("the space is served", `refusal: ${here.refusal}`); else pass("the space is served", space);
  if (here?.renderBlocked) console.log(`NOTE  rendering is blocked in ${space}: ${here.renderBlocked}`);

  // 3. The denied page is absent from the listing and from a search.
  const deniedFile = DENIED_PAGE.endsWith(".md") ? DENIED_PAGE : `${DENIED_PAGE}.md`;
  const list = await call("list-notes", { namePattern: `^${deniedFile.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$` });
  check(!list.isError && list.data?.total === 0, `list-notes: ${DENIED_PAGE} absent`, list.text);
  const search = await call("search-notes", { query: DENIED_TEXT, useRegex: false, maxResults: 100 });
  const names: string[] = (search.data?.results ?? []).map((r: Record<string, any>) => r.filename ?? r.name ?? "");
  check(!search.isError && !names.includes(deniedFile) && !names.includes(DENIED_PAGE), `search-notes: ${DENIED_PAGE} absent from the results for "${DENIED_TEXT}"`, search.isError ? search.text : `${names.length} result(s)`);
  const denied = await call("read-note", { filename: DENIED_PAGE });
  check(denied.isError && /access list/i.test(denied.text), `read-note ${DENIED_PAGE}: denied by the access list`, denied.text);

  // 4. The raw read of a page with queries.
  const raw = await call("read-note", { filename: RAW_PAGE });
  check(!raw.isError && typeof raw.data?.revision === "string" && raw.data.revision.length > 0, `read-note ${RAW_PAGE}: source with a revision`, raw.isError ? raw.text : `revision ${raw.data?.revision}, ${raw.data?.totalCharacters} characters`);

  // 5. The same page rendered, and a screenshot: granted or refused by the access list.
  const rendered = await call("render-note", { filename: RAW_PAGE });
  if (EXPECT_RENDER) {
    const src: string = raw.data?.content ?? "";
    const evaluated = !rendered.isError && !/\$\{|query\[\[/.test(rendered.text) && (!/\$\{|query\[\[/.test(src) || rendered.text !== src);
    check(evaluated, `render-note ${RAW_PAGE}: expressions and queries evaluated`, rendered.isError ? rendered.text : first(rendered.text, 600));
    const shot = await call("screenshot-note", { filename: SCREENSHOT_PAGE });
    const png = shot.image ? Buffer.from(shot.image.data, "base64") : Buffer.alloc(0);
    check(!shot.isError && shot.image?.mimeType === "image/png" && png.subarray(0, 8).toString("hex") === "89504e470d0a1a0a", `screenshot-note ${SCREENSHOT_PAGE}: a PNG`, shot.isError ? shot.text : `${png.length} bytes, ${shot.data?.width}x${shot.data?.height}`);
  } else {
    check(rendered.isError && /access list/i.test(rendered.text) && /"x"/.test(rendered.text), `render-note ${RAW_PAGE}: refused by the access list (no x)`, rendered.text);
    const shot = await call("screenshot-note", { filename: SCREENSHOT_PAGE });
    check(shot.isError && /access list/i.test(shot.text), `screenshot-note ${SCREENSHOT_PAGE}: refused by the access list (no x)`, shot.text);
  }

  // 6. A write outside the user's area: the access list refuses it, nothing is written.
  const stamp = `${Date.now().toString(36)}`;
  const outside = await call("create-note", { filename: `${OUTSIDE_PAGE} ${stamp}.md`, content: "acceptance test: must never be written\n" });
  check(outside.isError && /access list/i.test(outside.text), `create-note ${OUTSIDE_PAGE} ${stamp}: refused by the access list`, outside.text);

  // 7. A page with a space-lua block inside the user's area: the write filter refuses it, with rule and line.
  const area = WRITE_AREA.endsWith("/") ? WRITE_AREA : `${WRITE_AREA}/`;
  const codePage = `${area}Acceptance ${stamp} code.md`;
  const withCode = await call("create-note", { filename: codePage, content: "# Acceptance\n\n```space-lua\nprint('never')\n```\n" });
  check(withCode.isError && /write filter/i.test(withCode.text) && /line/i.test(withCode.text), `create-note ${codePage}: refused by the write filter (rule and line)`, withCode.text);

  // 8. A plain page in the area; a stale edit is rejected, the current revision is accepted.
  const page = `${area}Acceptance ${stamp}.md`;
  const created = await call("create-note", { filename: page, content: "# Acceptance\n\nfirst\n" });
  check(!created.isError && typeof created.data?.revision === "string", `create-note ${page}: created`, created.isError ? created.text : `revision ${created.data?.revision}`);
  if (!created.isError) {
    const stale = await call("edit-note", { filename: page, expectedRevision: "stale-revision", edits: [{ oldText: "first", newText: "second" }] });
    check(stale.isError && /revision/i.test(stale.text), `edit-note ${page} with a stale revision: rejected`, stale.text);
    const fresh = await call("edit-note", { filename: page, expectedRevision: created.data!.revision, edits: [{ oldText: "first", newText: "second" }] });
    check(!fresh.isError && fresh.data?.applied === true, `edit-note ${page} with the current revision: applied`, fresh.isError ? fresh.text : `revision ${fresh.data?.revision}`);
    const removed = await call("delete-note", { filename: page, expectedRevision: fresh.data?.revision ?? created.data!.revision });
    if (removed.isError) console.log(`NOTE  ${page} was not deleted (${first(removed.text, 200)}); remove it by hand.`);
    else pass(`delete-note ${page}: cleaned up`);
  }

  // 9. The report page: serving, a scan has run, no findings.
  const report = await call("read-note", { filename: REPORT_PAGE });
  const text: string = report.data?.content ?? "";
  check(!report.isError, `read-note ${REPORT_PAGE}: readable`, report.isError ? report.text : `${text.length} characters`);
  if (!report.isError) {
    check(/\* Serving: yes/.test(text), `${REPORT_PAGE}: serving`, first(text.match(/\* Serving:.*/)?.[0] ?? "no Serving line"));
    check(/\* Last scan: \d{4}-/.test(text), `${REPORT_PAGE}: a scan has run`, first(text.match(/\* Last scan:.*/)?.[0] ?? "no Last scan line"));
    check(/## Findings \(0\)/.test(text), `${REPORT_PAGE}: no findings`, first(text.match(/## Findings \(\d+\)/)?.[0] ?? "no Findings heading"));
    check(/## Files that are not pages \(0\)/.test(text), `${REPORT_PAGE}: no files outside the allowed-files list`, first(text.match(/## Files that are not pages \(\d+\)/)?.[0] ?? "no heading"));
  }

  await client.close();
  console.log(`\n${failures === 0 ? "All checks passed." : `${failures} check(s) failed.`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(`The test could not run: ${(e as Error).message}`);
  process.exit(2);
});
