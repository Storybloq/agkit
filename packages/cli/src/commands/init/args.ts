// T-221 — `agkit init` argument surface (STRICT zod; the validation authority).
//
// Two invocation shapes share ONE schema:
//   • INTERACTIVE (a TTY, no `--yes`) — every value below is optional; what is missing is asked
//     for, and every prompt has this file's flag as its non-interactive equivalent.
//   • `--yes` (the scriptable/CI path) — the frontend is PURE OVER FLAGS: a missing required
//     input is a `usage_error` (exit 2) naming the EXACT flag, decided with ZERO wire calls.
//
// SECRET CHANNEL: there is deliberately NO `--api-key` value flag. A provider key enters by env
// NAME (`--api-key-env`) or the TTY hidden prompt only — the T-217 rule, enforced structurally by
// `.strict()` (an `--api-key` token is an unrecognized key, so the parse refuses before any I/O).
//
// The EXISTING project is selected by the GLOBAL `--project <id>` selector (build-cli registers it
// globally and strips it from command input), so it is deliberately absent from this schema; the
// handler reads it from the injected `runtime.flags.project`. A NEW project is named by
// `--project-name`; the two together are contradictory and exit 2.
import { z } from "zod";

/**
 * A boolean flag that also accepts an explicit `--flag true|false` (the tokenizer yields a bare
 * `true` or the string). Normalized by `toBool` — never `z.coerce.boolean` (`Boolean("false")` is
 * `true`, a silent inversion). The `route/create.ts` pattern, verbatim.
 */
export const boolFlagArg = z.union([z.boolean(), z.enum(["true", "false"])]);
export function toBool(value: boolean | "true" | "false" | undefined): boolean {
  return value === true || value === "true";
}

export const initRunArgs = z
  .object({
    "project-name": z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe("Create a NEW project with this name (mutually exclusive with the global --project)."),
    "key-name": z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe("Label for the publishable key to mint (default: '<repo> (init)')."),
    provider: z
      .string()
      .min(1)
      .optional()
      .describe("Provider slug to store a credential for (server-owned vocabulary); pairs with --api-key-env."),
    "api-key-env": z
      .string()
      .min(1)
      .optional()
      .describe("Name of the env var holding the provider API key (the key never rides argv)."),
    "reuse-key": boolFlagArg
      .optional()
      .describe("Reuse the existing publishable key with the same name instead of minting another."),
    "rotate-credential": boolFlagArg
      .optional()
      .describe("The named provider already has a credential: rotate it deliberately instead of skipping."),
  })
  .strict();
export type InitRunInput = z.infer<typeof initRunArgs>;
