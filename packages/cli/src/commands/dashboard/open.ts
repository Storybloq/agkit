// `agkit dashboard [page]` handler (T-222 Step 8). Derives the dashboard origin LIVE from the
// guard-approved API URL's AS-metadata (D-10 — never a fabricated/hardcoded URL), joins the optional
// page through the closed grammar, and — ON A TTY ONLY — launches the browser. In non-TTY it prints
// the URL as the single JSON document and NEVER opens a browser (ticket FORBIDDEN). A metadata
// derivation failure fails LOUD as a RETRYABLE error (exit 1), never a fabricated URL.
import { z } from "zod";
import { type CommandHandler, requireRuntime, requireService } from "../types";
import { contractFacts } from "../../contract";
import { resolveDashboardOrigin, joinDashboardPage, validateDashboardPage } from "../../core/service/dashboard-url";
import { AsMetadataError } from "../../core/auth/as-metadata";
import { PreClassifiedError, retryableTransportEnvelope } from "../../core/errors/problem";

export const dashboardOpenArgs = z
  .object({
    // A plain optional string (S3): the closed page grammar is validated in the handler (before any
    // fetch), so a bad page is a static usage_error at zero network cost.
    page: z.string().min(1).optional().describe("Dashboard page to deep-link (e.g. 'account/security')."),
  })
  .strict();
export type DashboardOpenInput = z.infer<typeof dashboardOpenArgs>;

export const dashboardOpen: CommandHandler<DashboardOpenInput> = async (ctx, input) => {
  const runtime = requireRuntime(ctx);
  const service = requireService(ctx);
  const apiUrl = service.approvedApiUrl;
  if (apiUrl === undefined) {
    // A mis-wired shell: `dashboard` must be dispatched through the S6 URL-guard branch that injects
    // the approved URL. Fail loud (internal), never fall back to an unconfirmed origin.
    throw new Error("agkit: internal — dashboard requires the guard-approved apiUrl but it was not injected");
  }

  // Validate the page grammar FIRST — a bad page costs ZERO network I/O (no metadata fetch).
  if (input.page !== undefined) validateDashboardPage(input.page);

  // Derive the dashboard origin live. A fetch/parse/skew/size failure → a LOUD retryable error
  // (exit 1); we NEVER fabricate a URL (D-10, §B-9).
  let origin: string;
  try {
    origin = await resolveDashboardOrigin({ fetch: service.fetch }, apiUrl);
  } catch (err) {
    if (err instanceof AsMetadataError) {
      throw new PreClassifiedError(retryableTransportEnvelope(err.message));
    }
    throw err;
  }

  const url = joinDashboardPage(origin, input.page);

  // Non-TTY: NEVER launch a browser — emit the URL as the single JSON document (D-9). TTY: attempt
  // the best-effort launch; "launch_attempted" labels by reality (a spawn is not proof the browser
  // opened).
  if (runtime.isTTY === false) {
    return { data: { url, browser: "skipped_non_tty" }, meta: contractFacts() };
  }
  service.openUrl(url);
  return { data: { url, browser: "launch_attempted" }, meta: contractFacts() };
};
