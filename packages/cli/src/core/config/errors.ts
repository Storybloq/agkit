// Config/profile/context error surface (T-208, canonical L2-CLI-06). This ticket
// MINTS NO NEW ERROR CODE (FORBIDDEN): every local failure here — an unknown config
// key, a malformed/token-bearing config file, an unconfirmed non-default API URL on
// a non-TTY — reuses T-207's CLOSED CLI-local `usage_error` code. `ConfigError` is a
// thin typed subclass of `CliLocalError("usage_error")` so the existing dispatcher
// (`classifyThrownError` -> `if (err instanceof CliLocalError)`) renders it teachably
// with no shell change, and the process exits 2 (the taxonomy's TERMINAL class).
import { CliLocalError } from "../errors";

/**
 * A local config/context/guard failure, rendered as `usage_error` (exit 2). Carries
 * an optional runnable `hint` and RFC-9457-style `extra` (e.g. the list of valid
 * config keys, or the offending API host) that ride into the teachable envelope.
 */
export class ConfigError extends CliLocalError {
  override name = "ConfigError";
  constructor(detail: string, opts: { hint?: string; extra?: Record<string, unknown> } = {}) {
    super("usage_error", { detail, hint: opts.hint, extra: opts.extra, message: detail });
  }
}
