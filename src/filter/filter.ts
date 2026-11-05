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
import { isNeverAllowed, isReviewedMember, type Allowlist } from "./allowlist.ts";

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

/** Query aggregates, evaluated by the query engine itself (docs: Space Lua/Integrated Query/Aggregating). */
const AGGREGATES = new Set(["count", "sum", "min", "max", "avg", "array_agg"]);

/** `index.*` functions whose argument at the given position is a tag name. */
const TAG_ARGUMENT: Record<string, number> = {
  "index.tag": 0,
  "index.objects": 0,
  "index.contentPages": 0,
  "index.pages": 0,
  "index.getObjectByRef": 1,
};

/** The opening marker of a baked section (client/baked_sections/regions.ts): its expression is re-evaluated by a person's command. */
const BAKED_OPEN = /<!--#lua\s+([\s\S]*?)-->/g;
const SCRIPT_TAGS = new Set(["space-lua", "space-style"]);

/**
 * What the filter needs to judge a transclusion (docs/security.md, section 5): the page being
 * checked, for targets relative to it, and who may not see a target. Without it transclusions
 * are not checked.
 */
export type TransclusionCheck = {
  /** The name of the page being checked, without `.md`. */
  page: string;
  /** Why the page or file `target` may not be transcluded here, or null when it may. */
  denied(target: string): string | null;
};

/** The rule of a transclusion whose target its reader may not read: not code, so the refusals word it apart. */
export const TRANSCLUSION_RULE = "transclusion-denied";

/** A transclusion as it stands in the page: `![[target]]`, or the image form `![alt](path)`, which transcludes a page too. */
export type Transclusion = { from: number; to: number; raw: string; image: boolean };

/**
 * Finds `![[…]]` (no `]` inside) and `![…](…)` in one pass. Linear in the page's length whatever
 * the page holds: the position of the next `]` and `)` is looked up once and kept while it is
 * still ahead, and the scan goes on after a match, so a page of unclosed `![[` costs one scan,
 * not one per opener. Of several `![[` before one `]]` the first and the last are both reported:
 * which of them SilverBullet takes is not something the filter should have to know.
 */
export function findTransclusions(source: string): Transclusion[] {
  const out: Transclusion[] = [];
  const ahead = (char: string) => {
    let known = -2; // -1: none from here to the end
    return (from: number) => {
      if (known === -1) return -1;
      if (known < from) known = source.indexOf(char, from);
      return known;
    };
  };
  const nextBracket = ahead("]");
  const nextParen = ahead(")");
  let pos = source.indexOf("![");
  while (pos !== -1) {
    let next = pos + 2;
    const close = nextBracket(pos + 2);
    if (close === -1) break;
    if (source[pos + 2] === "[") {
      if (source[close + 1] === "]") {
        out.push({ from: pos, to: close + 2, raw: source.slice(pos + 3, close), image: false });
        const inner = source.lastIndexOf("![[", close);
        if (inner > pos) out.push({ from: inner, to: close + 2, raw: source.slice(inner + 3, close), image: false });
        next = close + 2;
      }
    } else if (source[close + 1] === "(") {
      const end = nextParen(close + 2);
      if (end !== -1) {
        // `(<a path> "title")` keeps its spaces; `(path "title")` ends at the first one.
        const inner = source.slice(close + 2, end).trim();
        const path = inner.startsWith("<") ? inner.slice(1).split(">")[0] : inner.split(/\s/)[0];
        if (path) out.push({ from: pos, to: end + 1, raw: path, image: true });
      }
    }
    pos = source.indexOf("![", next);
  }
  return out;
}

/** Bounds on one target: the length of a name, and how many of its `#`, `@` and `$` are read as the start of a suffix. */
const MAX_TARGET = 1024;
const MAX_READINGS = 32;
/** A URL with a scheme, or a protocol-relative one: not a file of the space. */
const EXTERNAL = /^([A-Za-z][A-Za-z0-9+.-]*:|\/\/)/;

/**
 * The pages or files a transclusion may resolve to, as names the access list is matched against.
 * SilverBullet 2.12.1 (measured, docs/security.md, section 5) takes `Page`, `/Page`, `^Page` and
 * `Page.md`, and cuts a heading (`#`), a position (`@`) or an anchor (`$`); the image form also
 * resolves `..` against the page's folder. Where a character could be part of the name or start
 * a suffix, both readings are returned, and the caller requires every one of them to be readable.
 */
export function transclusionTargets(raw: string, page: string, image: boolean): string[] {
  const out = new Set<string>();
  const add = (name: string) => {
    // No file has a name this long; what the filter cannot read as a name is refused as one.
    if (name.length > MAX_TARGET) name = name.slice(0, MAX_TARGET);
    // The shortest reading first: it is the one SilverBullet takes unless the character is part of the name.
    const cuts: number[] = [];
    for (let i = 0; i < name.length && cuts.length < MAX_READINGS; i++) if (name[i] === "#" || name[i] === "@" || name[i] === "$") cuts.push(i);
    if (!name.startsWith("#")) cuts.push(name.length); // `#Heading` alone is the page itself
    for (const cut of cuts) {
      const candidate = name.slice(0, cut).replace(/\.md$/, "");
      if (candidate && candidate !== page) out.add(candidate);
    }
  };
  if (!image) {
    const name = raw.split("|")[0].replace(/^\^/, "").replace(/^\/+/, "");
    add(name);
    if (name.trim() !== name) add(name.trim());
    return [...out];
  }
  if (EXTERNAL.test(raw)) return [];
  const readings = new Set([raw]);
  try {
    readings.add(decodeURIComponent(raw));
  } catch {}
  const folder = page.includes("/") ? page.slice(0, page.lastIndexOf("/")).split("/") : [];
  for (const reading of readings) {
    const absolute = reading.startsWith("/");
    for (const base of absolute ? [[]] : [[], folder]) {
      const segments = [...base];
      for (const segment of reading.split("/")) {
        if (segment === "" || segment === ".") continue;
        if (segment === "..") segments.pop();
        else segments.push(segment);
      }
      add(segments.join("/"));
    }
  }
  return [...out];
}

/** Pages the filter does not apply to: where code belongs (docs/security.md, section 2). */
export function isCodePlace(page: string): boolean {
  return page === "CONFIG" || page === "CONFIG.md" || page.startsWith("Library/");
}

export function checkPage(source: string, allow: Allowlist, transclusion?: TransclusionCheck): Verdict {
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

  // Directives: `${` outside code, brace-balanced like SilverBullet's parser. SilverBullet's parser
  // scans to the end of the text for every `${` that never closes, which is quadratic; the filter
  // spends at most a few times the page's length on it and refuses the page beyond that.
  let directives = 0;
  let budget = 64 * source.length + 1_000_000;
  const inCode = (pos: number) => codeRanges.some(([a, b]) => pos >= a && pos < b);
  for (let pos = source.indexOf("${"); pos !== -1; pos = source.indexOf("${", pos + 2)) {
    if (inCode(pos)) continue;
    let depth = 0, len = 0;
    loop: for (; pos + len < source.length; len++) {
      if (--budget < 0) {
        violations.push({ rule: "too-complex", detail: "too many unclosed ${ for the filter to check", line: lineOf(pos), from: pos, to: pos + 2 });
        return { ok: false, violations, directives };
      }
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

  // Baked sections: `<!--#lua EXPR -->` holds an expression that "Baked Sections: Update" re-evaluates
  // on the whole page, with the rights of the person who runs it. SilverBullet finds the markers with
  // this regex on the raw text, code blocks and code spans included, so the filter does the same.
  for (const m of source.matchAll(BAKED_OPEN)) {
    directives++;
    const found = checkExpression(m[1], allow);
    for (const v of found) violations.push({ ...v, line: lineOf(m.index!), from: m.index!, to: m.index! + m[0].length });
  }

  // Transclusions: SilverBullet expands them wherever they stand outside code, HTML blocks, HTML
  // comments and the frontmatter included, so they are found on the raw text like the baked markers.
  if (transclusion) {
    for (const t of findTransclusions(source)) {
      if (inCode(t.from)) continue;
      for (const target of transclusionTargets(t.raw, transclusion.page, t.image)) {
        const why = transclusion.denied(target);
        if (!why) continue;
        violations.push({ rule: TRANSCLUSION_RULE, detail: `${source.slice(t.from, Math.min(t.to, t.from + 60))}: ${why}`, line: lineOf(t.from), from: t.from, to: t.to });
        break; // one reason per transclusion
      }
    }
  }

  return { ok: violations.length === 0, violations, directives };
}

type Reason = { rule: string; detail: string };

/** What a directive body may reference without an allowlist entry, at one point of the walk. */
type Scope = {
  /** Names bound by `from x = …`, and `key` and `group` under `group by`. */
  bound: Set<string>;
  /** Inside a query clause other than `from`, where the aggregates are the query engine's own. */
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
   * names are not global names; everything else is, and must be on the allowlist.
   */
  const checkReference = (path: string[], scope: Scope, isCall: boolean): boolean => {
    const root = path[0];
    if (root === "_CTX" || scope.bound.has(root)) return true;
    const joined = path.join(".");
    if (isNeverAllowed(joined)) {
      // Never allowed whatever the allowlist says, except a reviewed member the operator named exactly
      // (`os.date`; docs/security.md, section 6). The refusal says when an exact entry would admit it.
      if (allow.excepts(path)) return true;
      push("denied-name", isReviewedMember(joined) ? `${joined} (allowable by an exact allowlist entry; not on this allowlist)` : joined);
      return false;
    }
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
            // A source without a name makes every field of the row a bare variable that shadows
            // globals; the filter could not tell a field from a global, so the row must be named.
            for (const f of fieldsOf(clause)) {
              if (f.name === "FieldProp") bound.add(text(f.firstChild!));
              else push("unnamed-query", `from ${short(f).slice(0, 30)}: bind the row, as in "from p = …"`);
            }
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
