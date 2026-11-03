// The index-time transform of the design (docs/security.md, section 10) and the
// variants the checks compare it with. CONFIG pages for the test space are
// built from these.

/** The shipped block, verbatim as in docs/security.md. A check asserts that. */
export const SHIPPED_TRANSFORM = `-- Shipped with the MCP server. Keep verbatim; the server checks for it at start.
local function confine(o)
  local page = string.match(o.ref, "^(.*)@%d+$") or ""
  if page == "CONFIG" or string.startsWith(page, "Library/") then return o end
  if o.script then o.script = "-- not loaded: outside CONFIG and Library/" end
  if o.style then o.style = "/* not loaded: outside CONFIG and Library/ */" end
  return o
end
tag.define { name = "space-lua", transform = confine }
tag.define { name = "space-style", transform = confine }`;

export const REPLACED_SCRIPT = "-- not loaded: outside CONFIG and Library/";
export const REPLACED_STYLE = "/* not loaded: outside CONFIG and Library/ */";

/** Variant A: drop outside objects with `return {}`. Defective in 2.12.1 (docs/facts/index-transform.md, section 4). */
export const VARIANT_A_TRANSFORM = `local function confine(o)
  local page = string.match(o.ref, "^(.*)@%d+$") or ""
  if page == "CONFIG" or string.startsWith(page, "Library/") then return o end
  return {}
end
tag.define { name = "space-lua", transform = confine }
tag.define { name = "space-style", transform = confine }`;

/** Keeps Library/ only: drops CONFIG's own objects too. Breaks the configuration after the first reload. */
export const DROP_CONFIG_TRANSFORM = `local function confine(o)
  local page = string.match(o.ref, "^(.*)@%d+$") or ""
  if string.startsWith(page, "Library/") then return o end
  if o.script then o.script = "-- not loaded" end
  if o.style then o.style = "/* not loaded */" end
  return o
end
tag.define { name = "space-lua", transform = confine }
tag.define { name = "space-style", transform = confine }`;

export const SECRET = "CONFIG-SECRET-4711";

export type ConfigVariant = "shipped" | "none" | "variantA" | "dropConfig";

/** The CONFIG page of the test space with one of the transform variants (or none). */
export function configPage(variant: ConfigVariant): string {
  const transform = {
    shipped: SHIPPED_TRANSFORM,
    none: "",
    variantA: VARIANT_A_TRANSFORM,
    dropConfig: DROP_CONFIG_TRANSFORM,
  }[variant];
  return `Configuration of the test space. The checks rewrite this page; the bootstrap restores it.

\`\`\`space-lua
config.set("agentTest.secret", "${SECRET}")
${transform}
\`\`\`
`;
}
