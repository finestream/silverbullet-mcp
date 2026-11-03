// The write filter (docs/security.md, section 5): given a page source and the
// allowlist, accepts the page or returns every reason it holds code.
//
// Markdown is parsed with @lezer/markdown (the parser SilverBullet builds on);
// `${...}` directives are found the way SilverBullet's own inline parser finds
// them (client/markdown_parser/parser.ts, LuaDirectives): `${` outside code,
// then brace balancing. Each directive body is parsed with the vendored Lua
// parser exactly as SilverBullet does it: wrapped as `_(<body>)`, and the
// rules walk the lezer tree. The parser files under vendor/silverbullet/ are
// SilverBullet's own (MIT, see the LICENSE.md there).

import { parser as luaParser } from "./vendor/silverbullet/parse-lua.js";
import { parser as mdParser } from "@lezer/markdown";
import type { SyntaxNode } from "@lezer/common";
import { NEVER_ALLOWED, type Allowlist } from "./allowlist.ts";

export type Violation = {
  rule: string;
  detail: string;
  /** 1-based line of the fence or directive in the page. */
  line: number;
  /** Offsets of the fence or directive in the page source, for the quarantine. */
  from: number;
  to: number;
};
export type Verdict = {
  ok: boolean;
  violations: Violation[];
  directives: number;
};

/** Fence languages SilverBullet executes or applies (docs/facts/execution-model.md, section 1). */
const EXECUTABLE_FENCES = new Set(["space-lua", "space-config", "space-style"]);

/** Markdown nodes whose text SilverBullet never parses for directives. */
const CODE_NODES = new Set(["FencedCode", "CodeBlock", "InlineCode"]);

/** Never-allowed roots: a reference to one of these is refused whatever the allowlist says. */
const DENIED_ROOTS = new Set(NEVER_ALLOWED.filter((n) => !n.includes(".")));
const DENIED_PATHS = new Set(NEVER_ALLOWED.filter((n) => n.includes(".")));

/** Query aggregates, evaluated by the query engine itself (docs: Space Lua/Integrated Query/Aggregating). */
const AGGREGATES = new Set(["count", "sum", "min", "max", "avg", "array_agg"]);

/** `index.*` functions whose argument at the given position is a tag name. */
const TAG_ARGUMENT: Record<string, number> = {
  "index.tag": 0,
  "index.objects": 0,
  "index.contentPages": 0,
  "index.pages": 0,
  "index.queryLuaObjects": 0,
  "index.getObjectByRef": 1,
};
const SCRIPT_TAGS = new Set(["space-lua", "space-style"]);

/** Pages the filter does not apply to: where code belongs (docs/security.md, section 2). */
export function isCodePlace(page: string): boolean {
  return page === "CONFIG" || page === "CONFIG.md" || page.startsWith("Library/");
}

export function checkPage(source: string, allow: Allowlist): Verdict {
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
          violations.push({ rule: "fence", detail: `\`\`\`${lang} block`, line: lineOf(n.from), from: n.from, to: n.to });
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
      const end = source.indexOf("\n", m.index!);
      violations.push({
        rule: "fence-hidden",
        detail: `\`\`\`${m[2]} outside a parsed fence (HTML block or comment?)`,
        line: lineOf(m.index!),
        from: m.index!,
        to: end === -1 ? source.length : end,
      });
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
    const found = checkExpression(body, allow);
    for (const v of found) violations.push({ ...v, line: lineOf(pos), from: pos, to: pos + len + 1 });
    pos += len;
  }

  return { ok: violations.length === 0, violations, directives };
}

type Reason = { rule: string; detail: string };

/** What a directive body may reference without an allowlist entry, at one point of the walk. */
type Scope = {
  /** Names bound by `from x = …` (`_` for an unnamed source), and `key` and `group` under `group by`. */
  bound: Set<string>;
  /** Inside a `where`, `select`, `order by`, `group by`, `having`, `limit` or `offset` clause: a bare name standing alone is a field of the row. */
  inClause: boolean;
};

/** Checks one directive body with SilverBullet's Lua parser; returns the reasons found, without duplicates. */
export function checkExpression(body: string, allow: Allowlist): Reason[] {
  const reasons: Reason[] = [];
  const seen = new Set<string>();
  const src = `_(${body})`;
  const tree = luaParser.parse(src);
  const text = (n: SyntaxNode) => src.slice(n.from, n.to);
  const short = (n: SyntaxNode) => text(n).slice(0, 40);
  let errors = 0;
  const push = (rule: string, detail: string) => {
    const key = `${rule}\n${detail}`;
    if (!seen.has(key)) {
      seen.add(key);
      reasons.push({ rule, detail });
    }
  };

  /**
   * A static reference path, called or not. Returns true when it is allowed. `_CTX` and the bound
   * names are not global names; inside a query clause a bare name standing alone is a field of the
   * row, unless it is a never-allowed name.
   */
  const checkReference = (path: string[], scope: Scope, isCall: boolean): boolean => {
    const root = path[0];
    if (root === "_CTX" || scope.bound.has(root)) return true;
    const joined = path.join(".");
    if (DENIED_ROOTS.has(root) || DENIED_PATHS.has(joined) || [...DENIED_PATHS].some((d) => joined.startsWith(d + "."))) {
      push("denied-name", joined);
      return false;
    }
    if (scope.inClause && path.length === 1 && !isCall) return true;
    if (allow.allows(path)) return true;
    push(isCall ? "call-not-allowed" : "reference-not-allowed", joined);
    return false;
  };

  /** `index.tag "x"` and friends: the tag argument must be a string literal that is not a script tag. */
  const checkTagArgument = (call: SyntaxNode, path: string[]) => {
    const joined = path.join(".");
    const position = TAG_ARGUMENT[joined];
    if (position === undefined) return;
    const arg = argumentsOf(call)[position];
    if (!arg) return; // no tag argument: every object of the kind
    if (arg.name !== "LiteralString") {
      push("tag-not-literal", `${joined}(${short(arg).slice(0, 30)})`);
      return;
    }
    const literal = text(arg).replace(/^(\[=*\[|["'])/, "").replace(/(\]=*\]|["'])$/, "");
    if (SCRIPT_TAGS.has(literal)) push("script-tag", `${joined} "${literal}"`);
  };

  /** A reference chain (`a`, `a.b`, `a[x].b`) used as a value. */
  const checkChain = (n: SyntaxNode, scope: Scope) => {
    const path = calleePath(n, src);
    if (path[0] === "<dynamic>") {
      // Rooted in a call or a parenthesised expression: not a static name.
      push("dynamic-reference", short(n));
    } else if (path[0] === "_CTX" || scope.bound.has(path[0])) {
      // Bound data: anything under it is data too.
    } else if (path.includes("<dynamic>")) {
      push("dynamic-reference", short(n));
    } else {
      checkReference(path, scope, false);
    }
    walkInner(n, scope);
  };

  /** Walks what a chain contains besides its names: the index expressions of a[x] and a rooted call or parenthesis. */
  const walkInner = (n: SyntaxNode, scope: Scope) => {
    if (n.name === "Name") return;
    if (n.name === "Property") return walkInner(n.firstChild!, scope);
    if (n.name === "MemberExpression") {
      for (let c = n.firstChild!.nextSibling; c; c = c.nextSibling) walk(c, scope);
      return walkInner(n.firstChild!, scope);
    }
    walk(n, scope);
  };

  const walk = (n: SyntaxNode, scope: Scope) => {
    if (n.type.isError) {
      errors++;
      return;
    }
    switch (n.name) {
      case "FunctionDef":
      case "Function":
      case "LocalFunction":
      case "FuncBody": // also `order by ... using function(a, b) ... end`
        push("function-definition", short(n));
        return; // nothing inside a definition is accepted anyway
      case "Assign":
      case "Local":
        push("assignment", short(n));
        break;
      case "Query": {
        if (!allow.allows(["query"])) push("call-not-allowed", "query[[...]]");
        const bound = new Set(scope.bound);
        const clauses: SyntaxNode[] = [];
        for (let c = n.firstChild; c; c = c.nextSibling) {
          const clause = c.name === "QueryClause" ? c.firstChild! : c;
          if (!clause.name.endsWith("Clause")) continue;
          clauses.push(clause);
          if (clause.name === "FromClause") {
            for (const f of fieldsOf(clause)) bound.add(f.name === "FieldProp" ? text(f.firstChild!) : "_");
          }
          if (clause.name === "GroupByClause") {
            bound.add("key");
            bound.add("group");
            for (const f of fieldsOf(clause)) if (f.name === "FieldProp") bound.add(text(f.firstChild!));
          }
        }
        for (const clause of clauses) {
          // The source expression of `from` is evaluated before any row exists: no field names there.
          walk(clause, { bound, inClause: clause.name !== "FromClause" });
        }
        return;
      }
      case "OrderBy": {
        // `using NAME` names a comparator: a global function, checked as a call.
        for (let c = n.firstChild; c; c = c.nextSibling) {
          if (c.name === "Name" && c.prevSibling?.name === "using") checkReference([text(c)], { ...scope, inClause: false }, true);
          else walk(c, scope);
        }
        return;
      }
      case "Property":
      case "MemberExpression":
        checkChain(n, scope);
        return;
      case "Name":
        if (isReference(n, src)) checkReference([text(n)], scope, false);
        return;
      case "FunctionCall": {
        const callee = n.firstChild!;
        // The wrapper call `_( ... )` that SilverBullet adds itself: only its arguments matter.
        if (n.from === 0 && n.parent?.name === "Block") {
          for (let c = callee.nextSibling; c; c = c.nextSibling) walk(c, scope);
          return;
        }
        const method = methodName(n, src);
        const path = calleePath(callee, src);
        if (method) path.push(method);
        if (path[0] === "<dynamic>" || path.includes("<dynamic>")) {
          push("dynamic-call", short(n));
        } else if (path[0] === "_CTX" || scope.bound.has(path[0])) {
          // A call on a value whose type the filter cannot know: only a `*.method` entry admits it.
          const last = path[path.length - 1];
          if (!(path.length > 1 && allow.allows(["*", last]))) push("call-not-allowed", `${path.join(".")} (a method on a value; write it as a function call)`);
        } else if (scope.inClause && path.length === 1 && AGGREGATES.has(path[0])) {
          // a query aggregate, evaluated by the query engine
        } else if (checkReference(path, scope, true)) {
          checkTagArgument(n, path);
        }
        walkInner(callee, scope);
        for (let c = callee.nextSibling; c; c = c.nextSibling) if (c.name !== "Name" || c.prevSibling?.name !== ":") walk(c, scope);
        return;
      }
    }
    for (let c = n.firstChild; c; c = c.nextSibling) walk(c, scope);
  };
  walk(tree.topNode, { bound: new Set(), inClause: false });
  if (errors > 0) push("parse-error", body.trim().slice(0, 40));
  return reasons;
}

/** The argument expressions of a call: `f "x"`, `f {…}` or `f(a, b)`. */
function argumentsOf(call: SyntaxNode): SyntaxNode[] {
  const last = call.lastChild!;
  if (last.name === "LiteralString" || last.name === "TableConstructor") return [last];
  // funcParams: "(" list<exp> ")" — the grammar inlines it, so the expressions are direct children after the callee.
  const out: SyntaxNode[] = [];
  let seenParen = false;
  for (let c = call.firstChild; c; c = c.nextSibling) {
    if (c.name === "(") { seenParen = true; continue; }
    if (!seenParen) continue;
    if (c.name === ")" || c.name === "," || c.name === "AggOrderBy") continue;
    out.push(c);
  }
  return out;
}

function fieldsOf(clause: SyntaxNode): SyntaxNode[] {
  const list = clause.getChild("FieldList");
  const out: SyntaxNode[] = [];
  if (!list) return out;
  for (let c = list.firstChild; c; c = c.nextSibling) if (c.name.startsWith("Field")) out.push(c);
  return out;
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

/** `obj:method(...)`: the Name after the ":" token among the call's children. */
function methodName(call: SyntaxNode, src: string): string | null {
  for (let c = call.firstChild; c; c = c.nextSibling) {
    if (c.name === ":" && c.nextSibling?.name === "Name") return src.slice(c.nextSibling.from, c.nextSibling.to);
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
  if (p.name === "FunctionCall" && prev?.name === ":") return false; // a:NAME()
  if (p.name === "FieldProp") return prev !== null; // {NAME = value}, from NAME = source: the first Name is a key
  void src;
  return !["AttName", "FuncName", "Label", "Goto", "ForNumeric", "NameList", "ArgList"].includes(p.name);
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

/** One line per violation, as the tools and the report show it. */
export function describe(v: Violation): string {
  return `line ${v.line}, ${v.rule}: ${v.detail}`;
}
