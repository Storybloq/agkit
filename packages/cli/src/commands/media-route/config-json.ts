// `--config-json <path>` consumer-side parse (T-220 §2-S1; OD-14). The file is read through the
// injected `CliRuntime.readTextFile` seam (the B0 single-fd bounded reader in run.ts) under a
// DEFENSIVE 1 MiB channel cap — 64× the server's 16 KiB config policy cap, which stays SERVER-
// owned (the plan door's 422 teaches; the CLI never copies wire policy, §5-F9). Every error here
// is STATIC + path-only: a config file can contain pasted secret material, so file CONTENT bytes
// never reach any error — the JSON.parse error message (which echoes content fragments) is
// deliberately dropped, and the path (user argv) rides displayCapped per R-V1.
import { CliLocalError } from "../../core/errors";
import { displayCapped } from "../../core/output/display";

/** Channel bound for the `--config-json` read — NOT the wire policy (server META owns that). */
export const CONFIG_JSON_READ_CAP_BYTES = 1_048_576;

const PATH_DISPLAY_CAP = 128;

/** Parse `--config-json` file text into the wire `config` member: a PLAIN JSON object only. */
export function parseConfigJsonObject(raw: string, path: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CliLocalError("usage_error", {
      detail: `${displayCapped(path, PATH_DISPLAY_CAP)}: could not be parsed as JSON`,
    });
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new CliLocalError("usage_error", {
      detail: `${displayCapped(path, PATH_DISPLAY_CAP)}: --config-json must contain a single JSON object`,
    });
  }
  return parsed as Record<string, unknown>;
}
