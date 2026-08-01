// The shared `--env NAME | --file PATH` selector for the `secret-source` noun (T-227 S5b).
//
// Both mutating verbs take EXACTLY ONE of the two, and the refusal for "neither" / "both" is the
// same static teachable in both places — so it is written once here rather than twice in handlers
// that could drift. STATIC by the `provider-key/secret-env.ts` R-H #2 discipline: no message
// interpolates the name or the path (a mis-typed `--env` argument may itself be a pasted secret).
import { z } from "zod";
import { CliLocalError } from "../../core/errors";

/** The arg shape both `add` and `remove` declare. Kept as a plain optional pair (never a `.refine`)
 *  so `spec.args.shape` stays readable — `--help` derives its option list from it. */
export const secretSourceSelectorShape = {
  env: z
    .string()
    .min(1)
    .optional()
    .describe("Name of an environment variable to declare as a secret source (the NAME, never the value)."),
  file: z
    .string()
    .min(1)
    .optional()
    .describe("Absolute path of a file whose CONTENT is a secret (regular file, chmod 600, POSIX only)."),
};

const NO_SELECTOR_DETAIL =
  "name exactly one source: --env <VAR_NAME> (an environment variable NAME) or --file <PATH> (an absolute path to an owner-only file).";
const BOTH_SELECTORS_DETAIL =
  "two sources were given at once — pass exactly one of --env <VAR_NAME> or --file <PATH>.";

/** One declaration selector: an env-var NAME or a file PATH, never both, never neither. */
export type SecretSourceSelector = { kind: "env"; name: string } | { kind: "file"; path: string };

/** Narrow the parsed `{env?, file?}` pair to the one selector it names. STATIC refusals only. */
export function requireSecretSourceSelector(input: { env?: string; file?: string }): SecretSourceSelector {
  if (input.env !== undefined && input.file !== undefined) {
    throw new CliLocalError("usage_error", { detail: BOTH_SELECTORS_DETAIL });
  }
  if (input.env !== undefined) return { kind: "env", name: input.env };
  if (input.file !== undefined) return { kind: "file", path: input.file };
  throw new CliLocalError("usage_error", { detail: NO_SELECTOR_DETAIL });
}
