// `quota clear --fields a,b` args + plan-change builder (T-219; quotas:write, danger PR — the
// same `quotas.upsert` plan-kind door as `set`, in RESET mode: the named members become `null` =
// deliberately uncapped; every unnamed member carries the server's current value forward).
//
// D-7 (scope honesty): `--fields` is REQUIRED — an omitted flag defaulting to clear-everything
// would be silent scope expansion. The vocabulary is CLOSED to the nullable five;
// `max_requests_per_second_per_user` has no legal null (the contract requires a value 1..1000) and
// is a static teachable refusal; unknown names and duplicates are usage_errors. r5-3: clear stays
// UPDATE-ONLY — an absent row is the honest not_found + hint (you cannot "clear" caps that were
// never configured; a create-with-all-null would INVENT a configuration, FORBIDDEN 5/6).
import { z } from "zod";
import { requireProject, type Ctx } from "../types";
import type { PlanChange } from "../../core/plan/types";
import { renderRoutePath } from "../../core/client/prepare";
import { CliLocalError, WireProblemError } from "../../core/errors";
import { mergeQuotaBody, NULLABLE_QUOTA_FIELDS, QUOTA_FIELDS } from "./merge";

const confirmArg = z
  .string()
  .min(1)
  .optional()
  .describe("The plan's confirm string (required to apply non-interactively; shown by the ceremony).");

export const quotaClearArgs = z
  .object({
    fields: z
      .string()
      .min(1)
      .describe("Comma-separated quota members to clear to uncapped (the nullable five; see --help)."),
    confirm: confirmArg,
  })
  .strict();
export type QuotaClearInput = z.infer<typeof quotaClearArgs>;

// Static teachable messages (A2/R13a). The valid vocabulary is enumerable and NOT user-derived, so
// naming it is value-free; the ONE non-clearable member gets its own precise refusal (D-7).
const RPS_NOT_CLEARABLE_DETAIL =
  "max_requests_per_second_per_user cannot be cleared — the contract requires a value (1..1000); change it with `agkit quota set --max-requests-per-second-per-user <n>`";
const FIELDS_VOCAB_DETAIL = `--fields must name clearable quota members (comma-separated, no duplicates) from: ${NULLABLE_QUOTA_FIELDS.join(", ")}`;

/** Module constant (S-E): the honest clear-on-absent-row teaching. */
export const QUOTA_CLEAR_404_HINT =
  "no quotas are configured for this project — there is nothing to clear; `agkit quota set` creates the configuration";

/** Parse + validate the closed `--fields` list (exported for direct unit coverage). An EMPTY
 *  token (trailing comma, ",,") rejects the whole list — silently dropping it would tolerate a
 *  malformed list the closed-vocabulary doctrine (D-7) exists to refuse. */
export function parseClearFields(raw: string): string[] {
  const names = raw.split(",").map((s) => s.trim());
  if (names.length === 0 || names.some((s) => s.length === 0)) {
    throw new CliLocalError("usage_error", { detail: FIELDS_VOCAB_DETAIL });
  }
  const seen = new Set<string>();
  for (const name of names) {
    if (seen.has(name)) {
      throw new CliLocalError("usage_error", { detail: FIELDS_VOCAB_DETAIL });
    }
    seen.add(name);
    if (name === "max_requests_per_second_per_user") {
      throw new CliLocalError("usage_error", { detail: RPS_NOT_CLEARABLE_DETAIL });
    }
    if (!QUOTA_FIELDS[name]?.nullable) {
      throw new CliLocalError("usage_error", { detail: FIELDS_VOCAB_DETAIL });
    }
  }
  return names;
}

/**
 * The PURE change builder (`PlanMutation.changes`, ASYNC). Validates the closed field list (zero
 * wire on a bad list), reads current state, and emits ONE `quota:update` change whose body is the
 * server's current six values with EXACTLY the named members nulled (the acceptance pin). 404 ⇒
 * the honest not_found + hint (update-only; never a fabricated create).
 */
export async function quotaClearChanges(input: unknown, ctx: Ctx): Promise<PlanChange[]> {
  const parsed = quotaClearArgs.parse(input);
  const fields = parseClearFields(parsed.fields);
  const pid = requireProject(ctx);

  let base: unknown;
  try {
    base = await ctx.client.request({ operationId: "quotas.get", params: { pid } });
  } catch (err) {
    if (err instanceof WireProblemError && err.problem.status === 404) {
      err.hintOverride = QUOTA_CLEAR_404_HINT;
    }
    throw err;
  }

  const body = mergeQuotaBody(base, {}, fields);
  return [
    {
      action: "update",
      resource: "quota",
      path: renderRoutePath("quotas.upsert", { pid }),
      body,
    },
  ];
}
