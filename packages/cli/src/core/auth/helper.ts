// The credential-helper runner (T-206, deliverable 1). Config names an EXECUTABLE
// (env.ts: AGKIT_CREDENTIAL_HELPER); its **stdout is ONE bare token**, trailing
// whitespace stripped, and is **NEVER logged** — not on success, not on timeout,
// not on a non-zero exit, and never placed in an Error/warning. Non-zero exit or
// timeout means "no credential" (the chain falls through), never a crash.
//
// Hardening (review): spawned with `shell:false` and NO arguments (no shell
// parsing / injection); child **stderr is IGNORED at the OS level** so a token
// accidentally printed there cannot leak; captured stdout is BYTE-CAPPED. A
// slow-warning fires at 5 s; a hard 10 s timeout SIGKILLs the child.
import type { SpawnFn } from "./types";

/** Hard timeout: 10 s (deliverable 1). */
export const HELPER_TIMEOUT_MS = 10_000;
/** Slow-warning threshold: 5 s (deliverable 1). */
export const HELPER_SLOW_MS = 5_000;
/** Cap captured stdout so a runaway helper cannot exhaust memory. */
const MAX_STDOUT_BYTES = 64 * 1024;

export interface HelperRunDeps {
  readonly spawn: SpawnFn;
  /** stderr diagnostics sink. NEVER receives the token — only status text. */
  readonly warn: (message: string) => void;
  /** Test overrides. */
  readonly timeoutMs?: number;
  readonly slowMs?: number;
}

/**
 * Run the credential helper. Resolves to the token (whitespace-stripped, non-empty)
 * or null (fall through). NEVER rejects — every failure path resolves to null so
 * the chain continues to its terminal loud/none decision.
 */
export function runCredentialHelper(command: string, deps: HelperRunDeps): Promise<string | null> {
  const timeoutMs = deps.timeoutMs ?? HELPER_TIMEOUT_MS;
  const slowMs = deps.slowMs ?? HELPER_SLOW_MS;

  return new Promise<string | null>((resolve) => {
    let settled = false;
    let capturedBytes = 0;
    const chunks: Buffer[] = [];

    const finish = (token: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(slowTimer);
      clearTimeout(killTimer);
      resolve(token);
    };

    let child: ReturnType<SpawnFn>;
    try {
      // shell:false — `command` is the executable itself, never shell-interpreted.
      // stdio: stdin ignored, stdout piped, STDERR IGNORED (no token leak via stderr).
      child = deps.spawn(command, [], {
        shell: false,
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
      });
    } catch {
      // ENOENT / EACCES on spawn — no credential, do not crash, do not log details.
      resolve(null);
      return;
    }

    const slowTimer = setTimeout(() => {
      // Status only — NEVER the token.
      deps.warn(`agkit: credential helper still running after ${Math.round(slowMs / 1000)}s...\n`);
    }, slowMs);

    const killTimer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      // Timeout => no credential. The (partial) stdout is DISCARDED, never logged.
      finish(null);
    }, timeoutMs);

    child.stdout?.on("data", (piece: Buffer) => {
      capturedBytes += piece.length;
      if (capturedBytes <= MAX_STDOUT_BYTES) {
        chunks.push(piece);
      } else {
        // Over cap: stop trusting this helper; kill and fall through.
        try {
          child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
        finish(null);
      }
    });

    child.on("error", () => {
      // Spawn/runtime error — no credential. Details are NOT logged (may embed paths).
      finish(null);
    });

    child.on("close", (code: number | null) => {
      if (code !== 0) {
        finish(null);
        return;
      }
      const token = Buffer.concat(chunks).toString("utf8").trim();
      finish(token.length > 0 ? token : null);
    });
  });
}
