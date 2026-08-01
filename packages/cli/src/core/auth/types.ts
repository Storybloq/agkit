// Resolved-credential shape + the injectable dependency seams (T-206, canonical
// L2-CLI-05). `ResolvedCredential` is what the chain produces and what `Ctx`
// carries to pure handlers; everything I/O (env, home dir, keychain, subprocess,
// stderr) is an INJECTED dependency so the whole chain is deterministically
// testable (PL-19: a test simulates "no secret-service" by making the keyring
// throw — no real OS backend needed).
import type { KeyringPort } from "./keyring";

/** WHERE the active credential came from. `none` = no credential resolved. */
export type CredentialSource = "env" | "keychain" | "insecure_file" | "helper" | "none";

/**
 * The credential resolved for this invocation. `insecure` is true ONLY for the
 * plaintext-file source (drives the persistent warning + the `insecure_storage`
 * surface). `token` is the bearer for the management API (consumed by the typed
 * client in T-211); it is NEVER logged and is masked by the T-205 redaction pass
 * if it ever reaches an envelope.
 */
export interface ResolvedCredential {
  readonly source: CredentialSource;
  readonly token: string | null;
  readonly insecure: boolean;
}

/** The sentinel for "no credential resolved" (local commands like `version`). */
export const NO_CREDENTIAL: ResolvedCredential = Object.freeze({
  source: "none",
  token: null,
  insecure: false,
});

/**
 * Injected dependencies for the credential chain. In production `run.ts` wires the
 * real seams (process.env, os.homedir, the napi keyring port, child_process.spawn,
 * a stderr writer); tests inject fakes. `service` defaults to `agkit-cli` (E.4 /
 * the ratified keychain service name).
 */
export interface CredentialDeps {
  readonly env: NodeJS.ProcessEnv;
  readonly homeDir: string;
  readonly keyring: KeyringPort;
  /** Whether stdin is an interactive terminal — feeds the PL-14 non-interactive gate. */
  readonly isTTY: boolean;
  /** `child_process.spawn`, injected so the credential-helper is testable. */
  readonly spawn: SpawnFn;
  /** Diagnostics sink (stderr). Best-effort, MUST NOT throw. Never receives a token. */
  readonly warn: (message: string) => void;
  /** Keychain service name; defaults to `agkit-cli`. */
  readonly service?: string;
}

/** The narrow slice of `child_process.spawn` the helper needs (injectable). */
export type SpawnFn = (
  command: string,
  args: readonly string[],
  options: {
    shell: false;
    stdio: readonly ["ignore", "pipe", "ignore"];
    windowsHide: boolean;
  },
) => SpawnedChild;

/** The narrow child surface the helper consumes. */
export interface SpawnedChild {
  readonly stdout: NodeJS.ReadableStream | null;
  on(event: "error", listener: (err: Error) => void): void;
  on(event: "close", listener: (code: number | null) => void): void;
  kill(signal?: NodeJS.Signals): boolean;
}
