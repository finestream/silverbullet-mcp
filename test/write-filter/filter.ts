// Spike: a write filter for pages, built on SilverBullet's own Lua parser.
//
// Given a page source and an allowlist of call roots, returns accept or reject
// with every reason found. Throw-away code: no error handling beyond what the
// matrix needs, no configuration beyond the allowlist.
//
// Markdown is parsed with @lezer/markdown (the parser SilverBullet builds on);
// `${...}` directives are found the way SilverBullet's own inline parser finds
// them (client/markdown_parser/parser.ts, LuaDirectives): `${` outside code,
// then brace balancing. Each directive body is parsed with the vendored Lua
// parser exactly as SilverBullet does it: wrapped as `_(<body>)`.

import { parser as luaParser } from "./vendor/silverbullet/parse-lua.js";
import { parser as mdParser } from "@lezer/markdown";
import type { SyntaxNode } from "@lezer/common";

export type Violation = { rule: string; detail: string; line: number };
export type Verdict = {
  ok: boolean;
  violations: Violation[];
  directives: number;
};

/** Fence languages SilverBullet executes or applies (docs/facts/execution-model.md, section 1). */
const EXECUTABLE_FENCES = new Set(["space-lua", "space-config", "space-style"]);

/**
 * Names that must not be referenced anywhere in an expression: the task's list
 * plus the obvious equivalents (string loading, metatables, the JS bridge, the
 * client syscall namespaces that read or write beyond the page).
 */
const DENIED_NAMES = new Set([
  "load", "loadstring", "dofile", "require",
  "_G", "rawget", "rawset", "rawequal", "rawlen", "getmetatable", "setmetatable",
  "os", "io", "net", "shell", "space", "config", "js", "debug", "package",
  "system", "editor", "datastore", "clientStore", "event", "sync",
]);

/** Markdown nodes whose text SilverBullet never parses for directives. */
const CODE_NODES = new Set(["FencedCode", "CodeBlock", "InlineCode"]);

export function checkPage(source: string, allow: string[]): Verdict {
  const violations: Violation[] = [];
  const lineOf = lineIndex(source);
  const tree = mdParser.parse(source);
  const codeRanges: [number, number][] = [];
  const fencePositions = new Set<number>();

  tree.iterate({
    enter(n) {
      if (CODE_NODES.has(n.name)) codeRanges.push([n.from, n.to]);
      if (n.name === "FencedCode") {
        const info = n.node.getChild("CodeInfo");
        const lang = info ? source.slice(info.from, info.to).trim().split(/\s+/)[0] : "";
        if (EXECUTABLE_FENCES.has(lang)) {
          fencePositions.add(n.from);
          violations.push({ rule: "fence", detail: `\`\`\`${lang} block`, line: lineOf(n.from) });
        }
      }
    },
  });

  // A fence inside an HTML block or comment is inert in SilverBullet 2.12
  // (docs/facts/execution-model.md, section 1) but is still rejected here: the filter should not have to
  // know which contexts the editor ignores. Line-based, so it also catches
  // fences the Markdown parser did not see as such.
  const fenceLine = /^[ \t]{0,3}(`{3,}|~{3,})[ \t]*(space-lua|space-config|space-style)\b/gm;
  for (const m of source.matchAll(fenceLine)) {
    if (!fencePositions.has(m.index!)) {
      violations.push({ rule: "fence-hidden", detail: `\`\`\`${m[2]} outside a parsed fence (HTML block or comment?)`, line: lineOf(m.index!) });
    }
  }

  // Directives: `${` outside code, brace-balanced like SilverBullet's parser.
  let directives = 0;
  const inCode = (pos: number) => codeRanges.some(([a, b]) => pos >= a && pos < b);
  for (let pos = source.indexOf("${"); pos !== -1; pos = source.indexOf("${", pos + 2)) {
    if (inCode(pos)) continue;
    let depth = 0, len = 0;
    loop: for (; pos + len < source.length; len++) {
      switch (source[pos + len]) {
        case "{": depth++; break;
        case "}": depth--; if (depth === 0) break loop; break;
      }
    }
    if (depth !== 0) continue; // unbalanced: SilverBullet treats it as plain text
    directives++;
    const body = source.slice(pos + 2, pos + len);
    checkExpression(body, allow, lineOf(pos), violations);
    pos += len;
  }

  return { ok: violations.length === 0, violations, directives };
}

/** Checks one directive body with SilverBullet's Lua parser. */
export function checkExpression(body: string, allow: string[], line: number, violations: Violation[]) {
  const src = `_(${body})`;
  const tree = luaParser.parse(src);
  const text = (n: SyntaxNode) => src.slice(n.from, n.to);
  const allowed = allowMatcher(allow);
  let errors = 0;

  const walk = (n: SyntaxNode) => {
    if (n.type.isError) {
      errors++;
      return;
    }
    switch (n.name) {
      case "FunctionDef":
      case "Function":
      case "LocalFunction":
      case "FuncBody": // also `order by ... using function(a, b) ... end`
        violations.push({ rule: "function-definition", detail: text(n).slice(0, 40), line });
        return; // nothing inside a definition is accepted anyway
      case "Assign":
      case "Local":
        violations.push({ rule: "assignment", detail: text(n).slice(0, 40), line });
        break;
      case "Query":
        if (!allowed(["query"])) violations.push({ rule: "call-not-allowed", detail: "query[[...]]", line });
        break;
      case "Name":
        if (isReference(n, src) && DENIED_NAMES.has(text(n))) {
          violations.push({ rule: "denied-name", detail: text(n), line });
        }
        break;
      case "FunctionCall": {
        // Skip the wrapper call `_( ... )` that SilverBullet adds itself.
        if (n.from === 0 && n.parent?.name === "Block") break;
        const callee = n.firstChild!;
        const path = calleePath(callee, src);
        const method = methodName(n, callee, src);
        if (method) path.push(method);
        if (path.includes("<dynamic>")) {
          violations.push({ rule: "dynamic-call", detail: text(n).slice(0, 40), line });
        } else if (!allowed(path)) {
          violations.push({ rule: "call-not-allowed", detail: path.join("."), line });
        }
        break;
      }
    }
    for (let c = n.firstChild; c; c = c.nextSibling) walk(c);
  };
  walk(tree.topNode);
  if (errors > 0) violations.push({ rule: "parse-error", detail: body.trim().slice(0, 40), line });
}

/** Static dotted path of a callee, or a path containing "<dynamic>" when it cannot be known statically. */
function calleePath(n: SyntaxNode, src: string): string[] {
  switch (n.name) {
    case "Name":
      return [src.slice(n.from, n.to)];
    case "Property": { // a.b
      const member = n.lastChild!;
      return [...calleePath(n.firstChild!, src), src.slice(member.from, member.to)];
    }
    case "MemberExpression": // a["b"], a[x]
      return [...calleePath(n.firstChild!, src), "<dynamic>"];
    default: // Parens, a call's result, a literal, ...
      return ["<dynamic>"];
  }
}

/** `obj:method(...)`: the Name right after the callee, separated by ":". */
function methodName(call: SyntaxNode, callee: SyntaxNode, src: string): string | null {
  const next = callee.nextSibling;
  if (next?.name === "Name" && src.slice(callee.to, next.from).includes(":")) {
    return src.slice(next.from, next.to);
  }
  return null;
}

/** A Name is a variable reference unless it is a member name, a key, a parameter or a label. */
function isReference(n: SyntaxNode, src: string): boolean {
  const p = n.parent;
  if (!p) return true;
  // lezer hands out a fresh SyntaxNode object per step, so compare positions, not identity.
  const prev = n.prevSibling;
  if (p.name === "Property" && prev) return false; // a.NAME
  if (p.name === "FunctionCall" && prev && src.slice(prev.to, n.from).includes(":")) return false; // a:NAME()
  return !["FieldProp", "AttName", "FuncName", "Label", "Goto", "ForNumeric", "NameList", "ArgList"].includes(p.name);
}

/** Allowlist entries: exact dotted names (`template.each`), or a prefix (`template.*`). */
function allowMatcher(allow: string[]) {
  const exact = new Set(allow.filter((a) => !a.endsWith(".*")));
  const prefixes = allow.filter((a) => a.endsWith(".*")).map((a) => a.slice(0, -2));
  return (path: string[]) => {
    const joined = path.join(".");
    return exact.has(joined) || prefixes.some((p) => joined === p || joined.startsWith(p + "."));
  };
}

function lineIndex(source: string) {
  const starts = [0];
  for (let i = 0; i < source.length; i++) if (source[i] === "\n") starts.push(i + 1);
  return (pos: number) => {
    let lo = 0, hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= pos) lo = mid; else hi = mid - 1;
    }
    return lo + 1;
  };
}
