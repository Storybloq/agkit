// `agkit mcp doctor` handler (T-228 req 3, MCP-12). A diagnostic whose DATA is a report: it emits
// a SUCCESS envelope carrying all four checks and encodes the aggregate verdict in the PROCESS EXIT
// via `verdictExit` (pass→0, all-retryable→1, any-terminal→2) — the report is never an error
// document, because an error envelope has no `data` and a triage command that throws its own report
// away is useless. The pure check runner lives in `core/mcp/doctor.ts`; this handler only assembles
// the injected seams (`requireRuntime` + `requireService`) and maps the verdict onto the exit
// channel. `meta` stays `contractFacts()` — load-bearing here, because `meta.management_version` is
// the client pin the `contract_version` row compares against, so ONE document carries both sides.
//
// A KEYCHAIN THAT IS BROKEN NEVER REACHES THIS HANDLER, AND THAT IS CORRECT. The shell resolves the
// credential BEFORE dispatch for every credential-consuming command; a backend that is unavailable
// with no lower-precedence fallback surfaces there as the ratified loud two-remedy terminal error
// (exit 2). `agkit selftest` behaves identically today. Do NOT "fix" this by catching it into a
// check row — that would require resolving the credential here, i.e. exactly the second credential
// path the requirement forbids (see `core/mcp/doctor.ts`'s header).
import { z } from "zod";
import { type CommandHandler, requireRuntime, requireService } from "../types";
import { contractFacts } from "../../contract";
import { runMcpDoctor } from "../../core/mcp/doctor";
import { EXIT } from "../../core/errors";

/**
 * A boolean flag that also accepts an explicit `--offline true|false` (the tokenizer yields a bare
 * `true` or the string). Normalized by `toBool` — never `z.coerce.boolean` (`Boolean("false")` is
 * `true`, a silent inversion). Declared LOCALLY, exactly as `setup/args.ts`, `route/create.ts` and
 * `init/args.ts` each declare their own copy: the shared-module form (`agent/args-common.ts`)
 * exists for a noun FAMILY, and `mcp doctor`'s flags have nothing in common with its siblings'.
 */
const boolFlagArg = z.union([z.boolean(), z.enum(["true", "false"])]);
function toBool(value: boolean | "true" | "false" | undefined): boolean {
  return value === true || value === "true";
}

export const mcpDoctorArgs = z
  .object({
    offline: boolFlagArg
      .optional()
      .describe("Skip the server probe entirely: report the local checks only, with no network I/O."),
  })
  .strict();
export type McpDoctorInput = z.infer<typeof mcpDoctorArgs>;

export const mcpDoctor: CommandHandler<McpDoctorInput> = async (ctx, input) => {
  const runtime = requireRuntime(ctx);
  const service = requireService(ctx);
  // Fail LOUD on a mis-wired shell (the `agent sync` idiom): a doctor that silently lost its
  // symlink-following reader would report "not registered" on a dotfiles-managed machine — the
  // exact false negative D-7 exists to kill, reintroduced as a seam bug.
  if (runtime.readTextFile === undefined) {
    throw new Error("agkit: internal — mcp doctor requires the readTextFile seam but it was not injected");
  }

  const offline = toBool(input.offline);
  const { checks, verdict } = await runMcpDoctor({
    client: ctx.client,
    // THE chain result the shell produced for this dispatch — never re-derived here.
    credential: ctx.credential,
    installFs: service.installFs,
    readTextFile: runtime.readTextFile,
    homeDir: runtime.homeDir,
    cwd: runtime.cwd,
    platform: service.platform,
    env: runtime.env,
    offline,
  });

  // Map the verdict onto the exit channel: `pass` omits the member (exit 0); the two failure
  // classes ride the closed {RETRYABLE, TERMINAL} taxonomy. The envelope bytes are identical
  // regardless of exit — only the process exit encodes the verdict.
  const verdictExit =
    verdict === "terminal_failures"
      ? EXIT.TERMINAL
      : verdict === "retryable_failures"
        ? EXIT.RETRYABLE
        : undefined;

  return {
    // `offline` rides the DOCUMENT, not only the argv a machine consumer never sees: the flag
    // changes what rows (c)/(d) MEAN, and a mode that changes a document's meaning belongs in it.
    data: { ok: verdict === "pass", offline, checks },
    ...(verdictExit !== undefined ? { verdictExit } : {}),
    meta: contractFacts(),
  };
};
