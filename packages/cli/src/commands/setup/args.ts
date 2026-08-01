// T-224 — `agkit setup` argument surface (STRICT zod; the validation authority).
//
// Two flags, both optional, and the whole schema is `.strict()` — an unrecognized token is a
// `usage_error` (exit 2) BEFORE a single byte of the filesystem is touched, which is the property
// a provisioning command most needs (a typo must never half-provision a machine).
//
//   --check          report what WOULD change and write NOTHING (exit 1 on any drift, 0 converged)
//   --client codex   additionally reconcile `~/.codex/config.toml` (the Codex MCP client)
//
// `--client` is a CLOSED enum, not a free string: every value it admits is a client whose config
// this command knows how to edit surgically, and a name we do not know must fail at parse time
// rather than after three other legs have already written.
import { z } from "zod";

/**
 * A boolean flag that also accepts an explicit `--flag true|false` (the tokenizer yields a bare
 * `true` or the string). Normalized by `toBool` — never `z.coerce.boolean` (`Boolean("false")` is
 * `true`, a silent inversion). Declared LOCALLY, exactly as `route/create.ts` and `init/args.ts`
 * each declare their own copy: the shared-module form (`agent/args-common.ts`) exists for a noun
 * FAMILY, and `setup` is one command.
 */
export const boolFlagArg = z.union([z.boolean(), z.enum(["true", "false"])]);
export function toBool(value: boolean | "true" | "false" | undefined): boolean {
  return value === true || value === "true";
}

/** The MCP clients whose config `setup` can reconcile beyond the always-on Claude user scope. */
export const SETUP_CLIENTS = ["codex"] as const;

export const setupRunArgs = z
  .object({
    check: boolFlagArg
      .optional()
      .describe("Report what would change and write NOTHING: exit 1 if anything is out of date, 0 when converged."),
    client: z
      .enum(SETUP_CLIENTS)
      .optional()
      .describe("Also register with this MCP client's own config (codex: ~/.codex/config.toml)."),
  })
  .strict();
export type SetupRunInput = z.infer<typeof setupRunArgs>;
