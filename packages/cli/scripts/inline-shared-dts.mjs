// Post-build declaration inliner (T-211, A19). tsup's rollup-dts leaves the ONE workspace type
// import in the packed declarations — `@agentkit-cloud/shared/wire-contract/management-types.gen`
// (the generated operation-keyed `Operations` map) — because that subpath resolves via the
// `default` condition to a `.ts` SOURCE and rollup-dts only bundles `.d.ts`. A consumer install
// has no `@agentkit-cloud/shared`, so that import would break every downstream compile.
//
// The `.gen` module is TYPE-ONLY and fully SELF-CONTAINED (zero imports, zero runtime), so we
// inline it verbatim in place of the import, stripping only the `export ` keyword from its
// top-level type declarations — the DTOs become module-internal (available to the exported
// `ManagementClient`'s typed methods) WITHOUT widening the packed library's public export surface.
// The result: a self-contained `.d.ts` with no surviving `@agentkit-cloud/` specifier (A19) that a
// clean-room consumer can compile a typed operation against (A38).
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const cliRoot = resolve(here, "..");
const distDir = join(cliRoot, "dist");
const genPath = resolve(cliRoot, "../shared/src/wire-contract/management-types.gen.ts");

const GEN_SPECIFIER = "@agentkit-cloud/shared/wire-contract/management-types.gen";
const escaped = GEN_SPECIFIER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// `import { … } from '…';` or `import type { … } from '…';`, single- or double-quoted.
const IMPORT_RE = new RegExp(`^import(?:\\s+type)?\\s+\\{[^}]*\\}\\s+from\\s+['"]${escaped}['"];?[ \\t]*$`, "m");

/** The `.gen` source with `export ` stripped from its top-level declarations (module-internal). */
function inlinedGen() {
  const src = readFileSync(genPath, "utf8");
  if (/^\s*import\s/m.test(src)) {
    throw new Error(`${GEN_SPECIFIER} is no longer self-contained (it now has imports) — the inliner must be revisited`);
  }
  const internal = src.replace(/^export (interface|type) /gm, "$1 ");
  // The marker comment deliberately OMITS the workspace specifier: the pack probe (A19) fails on
  // ANY `@agentkit-cloud/` occurrence in a packed .d.ts — a broad fixed-string scan that also
  // catches side-effect imports and triple-slash references — so the inlined text must not
  // reintroduce the string it exists to eliminate.
  return `// [inlined from the shared management-types.gen module — self-contained type-only DTO map, T-211 A19]\n${internal}`;
}

let changed = 0;
for (const name of readdirSync(distDir)) {
  if (!name.endsWith(".d.ts")) continue;
  const p = join(distDir, name);
  const text = readFileSync(p, "utf8");
  if (!IMPORT_RE.test(text)) continue;
  // Function replacement so `$`-sequences inside the inlined types are NEVER interpreted as
  // replacement patterns (template-literal types + `$def` references contain `$`).
  writeFileSync(p, text.replace(IMPORT_RE, () => inlinedGen()));
  changed++;
  console.log(`inline-shared-dts: inlined ${GEN_SPECIFIER} into dist/${name}`);
}
if (changed === 0) console.log(`inline-shared-dts: no .d.ts imported ${GEN_SPECIFIER} — nothing to inline`);
