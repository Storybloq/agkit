// The `SecretRef` INPUT shape (T-227 R7 / D0-H v2) — the ONE way a secret-bearing argument names
// its material without carrying it on argv. Three members, exactly as the ticket freezes them:
//
//   {source:"env",    name }   — an environment-variable NAME (indirection; the value is read here)
//   {source:"file",   path }   — a path whose CONTENT is the secret (POSIX identity-hardened read)
//   {source:"inline", value}   — the literal value (the caller already holds it)
//
// WHY THIS MODULE IS DELIBERATELY DEPENDENCY-LIGHT. It is imported from two directions: the CLI
// resolution core (`secret-env.ts`, which pulls `Ctx` + the filesystem core) and — in the wave that
// un-excludes `provider-key add`/`rotate` over MCP — the tool-definition compiler, which must be
// able to project this union into JSON Schema WITHOUT dragging a filesystem reader or a command
// context into the MCP surface. So the only import here is zod, and the only exports are the schema,
// the type, and the two description strings the tool surface asserts.
//
// STRICTNESS IS LOAD-BEARING, not tidiness. Each member is `.strict()` and the discriminator is a
// literal, so `{source:"env", name:"X", value:"…"}` — an inline secret smuggled alongside an
// innocuous env reference — is a PARSE failure, not a silently-ignored extra key. A discriminated
// union of closed objects is also exactly what the schema compiler emits as a `oneOf` (the
// issuer-create precedent), so the wire projection needs no special case.
import { z } from "zod";

/** `{source:"env", name}` — the env-var NAME channel. The value is never named on the wire. */
export const envSecretRefSchema = z
  .object({
    source: z.literal("env"),
    name: z
      .string()
      .min(1)
      .max(256)
      .describe("Name of an environment variable holding the secret (the NAME, never the value)."),
  })
  .strict();

/** `{source:"file", path}` — the file-CONTENT channel (POSIX-only; see `core/config/secret-sources`). */
export const fileSecretRefSchema = z
  .object({
    source: z.literal("file"),
    path: z
      .string()
      .min(1)
      .max(4096)
      .describe("Absolute path to a file whose CONTENT is the secret (regular file, mode 600, POSIX only)."),
  })
  .strict();

/**
 * The warning every tool description carrying a `SecretRef` argument must reproduce (T-227 R7):
 * `inline` is always accepted because the caller already holds the value — but on the MCP channel
 * that means the secret is in the conversation transcript, which the operator has to know.
 */
export const SECRET_REF_INLINE_WARNING =
  "source \"inline\" places the secret value in conversation context — prefer \"env\" or \"file\", which name a pre-declared source instead of carrying the material.";

/** `{source:"inline", value}` — the literal value. Always accepted; always the loudest choice. */
export const inlineSecretRefSchema = z
  .object({
    source: z.literal("inline"),
    value: z.string().min(1).describe(`The secret value itself. ${SECRET_REF_INLINE_WARNING}`),
  })
  .strict();

/**
 * `SecretRef` — the three-member discriminated union (ticket req 7's exact shape). Unknown keys are
 * rejected on every arm and the discriminator is exact, so there is no "extra field" path by which a
 * second source could ride along with the first.
 */
export const secretRefSchema = z
  .discriminatedUnion("source", [envSecretRefSchema, fileSecretRefSchema, inlineSecretRefSchema])
  .describe(
    `How to obtain the secret: {source:"env",name} reads a pre-declared environment variable, ` +
      `{source:"file",path} reads a pre-declared file, {source:"inline",value} carries the value. ` +
      SECRET_REF_INLINE_WARNING,
  );

/** The resolved TS type — the ONE internal secret-reference shape both adapters (CLI argv flags, the
 *  MCP object union) map into before `resolveSecretRef` sees it. */
export type SecretRef = z.infer<typeof secretRefSchema>;

/** The closed set of source discriminators (for exhaustiveness assertions + teachable messages). */
export const SECRET_REF_SOURCES = ["env", "file", "inline"] as const;
