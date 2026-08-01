// T-222 step 7 (A9 / B7) — the child-output SCRUBBER + a least-privilege child ENVIRONMENT for the
// `npm install -g` self-update. npm's stdout/stderr can carry credentials (registry `_authToken`,
// URL userinfo, lifecycle output), possibly SPLIT across read chunks; the sink line-buffers and
// REDACTS before anything reaches our stderr (never raw child bytes). On a newline-less flood the
// forced flush SCRUBS FIRST and CUTS SECOND behind a holdback, so a credential straddling the cut
// can never be halved into the clear, and a value still ARRIVING when the cut falls is masked to the
// window edge with its continuation suppressed by a sticky latch. The env is CONSTRUCTED from an
// ALLOWLIST (never filtered out of the parent's): the child receives only the variables `npm
// install -g` needs, so a credential reaches it neither under an unrecognized NAME nor inside a
// registry/proxy URL's userinfo. Provider secrets are matched by the shared secret-NAME pattern, so
// no provider literal appears in this source (FORBIDDEN 9).
import { REDACTED, isSecretFieldName, redactText } from "../output/redaction";

/** Force-flush a newline-less buffer once it exceeds this (a runaway line can't grow unbounded). */
export const CHILD_SINK_MAX_LINE = 65_536;
/**
 * Bytes of the ALREADY-SCRUBBED window held back across a forced flush. The invariant it buys: every
 * SELF-DELIMITING credential `scrubChildLine` can match is STRICTLY shorter than this — the ratified
 * management-token formats are `mgmt_` + 43 base62 (48) and the class-prefixed `mgmt_ci_`/`mgmt_at_`/
 * `mgmt_rt_` + 43 (51), and the longest auth-assignment KEY is `authorization` (13). A credential
 * that is still ARRIVING when the cut falls therefore STARTS inside the retained tail, is retained
 * WHOLE, and gets masked by a later push once it completes. 1_024 is ~20x the longest ratified
 * format — room for future registered formats with no re-tuning — while the retained tail stays
 * negligible against `CHILD_SINK_MAX_LINE` (the flood is still bounded and still emitted).
 */
export const CHILD_SINK_HOLDBACK = 1_024;

/**
 * Scrub ONE line of child output. Layered, fail-safe (over-masks):
 *   1. the shared mgmt-token VALUE registry (`redactText` — same source as output redaction, B2);
 *   2. credential-bearing URL userinfo (`https://user:pass@host`);
 *   3. normalized auth assignments (`_authToken=`, `_auth=`, `authorization=`, `password=` — npmrc /
 *      env / `//registry/:_authToken=` forms).
 */
export function scrubChildLine(line: string): string {
  let out = redactText(line);
  // URL userinfo: keep the scheme + host, mask the `user:pass` credential segment.
  out = out.replace(/(\bhttps?:\/\/)[^/@\s:]+:[^/@\s]+@/gi, `$1${REDACTED}@`);
  // Auth assignments in any of npm's forms (leading `//registry/:` prefix included via the loose head).
  out = out.replace(/(_authtoken|_auth|authorization|password)(\s*[=:]\s*)\S+/gi, `$1$2${REDACTED}`);
  return out;
}

/**
 * Mask a credential head left OPEN at the END of a forced-flush window: a `scheme://user:pass` whose
 * terminating `@` has not arrived yet, which rule 2 above structurally cannot match. Unlike the token
 * formats this head is UNBOUNDED (userinfo may exceed `CHILD_SINK_HOLDBACK`), so the retained tail
 * alone cannot protect it — mask it to the window edge and let the sticky latch swallow the rest.
 * Applied ONLY to a forced-flush window: within a normal line the `@` is still to come in the SAME
 * buffer, where rule 2 handles it without over-masking an ordinary `host:port` URL.
 */
function maskOpenCredentialTail(window: string): string {
  return window.replace(/(\bhttps?:\/\/)[^/@\s:]+:[^/@\s]*$/i, `$1${REDACTED}`);
}

/** A bounded, line-buffered redacting sink over one child stream. */
export interface RedactingSink {
  /** Feed a raw child chunk (any framing — lines may split across chunks). */
  push: (chunk: string) => void;
  /** Emit the trailing partial line, if any (stream end). */
  flush: () => void;
  /** The sticky latch: is the sink inside a credential VALUE that straddled a forced flush? */
  insideOpenValue: () => boolean;
}

/**
 * A bounded, line-buffered redacting sink. `push` accumulates chunks; each COMPLETE line is scrubbed
 * and handed to `write`; `flush` emits any trailing partial line. A newline-less flood past
 * `CHILD_SINK_MAX_LINE` is force-flushed — SCRUB FIRST, CUT SECOND:
 *   • the WHOLE buffered window is scrubbed before the cut is taken, so every COMPLETE credential in
 *     it is already masked when the cut falls. (Cutting the RAW buffer — the pre-B7 shape — emits the
 *     HEAD of a straddling credential in the clear: neither half matches the full pattern, so
 *     retaining an overlap protects the retained side only, never the emitted one.)
 *   • only `scrubbed.length - CHILD_SINK_HOLDBACK` is emitted; the tail is RETAINED as the new
 *     buffer, so an INCOMPLETE credential — shorter than the holdback, by that constant's invariant —
 *     is retained whole and masked on a later push once it completes.
 *   • the retained tail is therefore already-scrubbed text. `scrubChildLine` is IDEMPOTENT over the
 *     mask (`(sensitive)` matches no VALUE pattern and carries no `:` for the userinfo rule, and
 *     `key=(sensitive)` re-masks to itself), so re-scrubbing the line the tail eventually completes
 *     can neither corrupt nor unmask it.
 *   • the residual case the holdback CANNOT cover: an auth assignment's value is unbounded (`\S+`),
 *     so when the window scrub's redaction runs to the window END the value is still arriving and its
 *     continuation bytes — no longer attached to their key — would be emitted in the clear. The sink
 *     latches `insideOpenValue` and DROPS every following non-whitespace byte until the first
 *     whitespace/newline. A COMPLETE secret that ends exactly at the window edge is indistinguishable
 *     from a truncated one, so the latch fires there too and over-masks the next run — fail-safe, and
 *     bounded by the next whitespace. Bounded content LOSS is accepted only here: benign flood text
 *     never triggers the latch and is emitted in full.
 */
export function createRedactingSink(write: (line: string) => void): RedactingSink {
  let buf = "";
  // Sticky: the window ended INSIDE a credential value, so the bytes still to come belong to it.
  let openValue = false;
  const emit = (text: string): void => {
    if (text.length > 0) write(scrubChildLine(text));
  };
  const forceFlush = (): void => {
    const window = buf;
    const scrubbed = maskOpenCredentialTail(scrubChildLine(window));
    // Redaction reaching the window END means a value was still arriving when the cut fell (the raw
    // window's last char is non-whitespace, so the value has no terminator yet) — latch.
    openValue = scrubbed.endsWith(REDACTED) && !/\s$/.test(window);
    // `Math.max`: scrubbing can COLLAPSE the window below the holdback (one giant masked value), and
    // a negative cut would slice from the end. Cut 0 ⇒ emit nothing, retain all: still bounded,
    // because the retained text is shorter than the window it replaced.
    const cut = Math.max(0, scrubbed.length - CHILD_SINK_HOLDBACK);
    // Already scrubbed — hand it to `write` directly rather than paying a second 64K scrub pass.
    if (cut > 0) write(scrubbed.slice(0, cut));
    buf = scrubbed.slice(cut);
  };
  return {
    push(chunk: string): void {
      let text = chunk;
      if (openValue) {
        // Suppress the credential value's continuation. The latch clears AT the first whitespace,
        // which is kept (a `\n` must still terminate the buffered line).
        const boundary = text.search(/\s/);
        if (boundary === -1) return; // every byte is still value continuation — drop the chunk whole
        text = text.slice(boundary);
        openValue = false;
      }
      buf += text;
      let nl = buf.indexOf("\n");
      while (nl !== -1) {
        emit(buf.slice(0, nl)); // the line without its trailing newline
        buf = buf.slice(nl + 1);
        nl = buf.indexOf("\n");
      }
      if (buf.length > CHILD_SINK_MAX_LINE) forceFlush();
    },
    flush(): void {
      if (buf.length > 0) {
        emit(buf);
        buf = "";
      }
      // The latch deliberately SURVIVES a flush: flush means "emit what you hold", not "the value
      // you were suppressing has ended". A chunk arriving after it is still value continuation.
    },
    insideOpenValue(): boolean {
      return openValue;
    },
  };
}

/**
 * The CLOSED set of environment-variable names the npm child may inherit, lowercased (npm honours
 * both `npm_config_x` and `NPM_CONFIG_X`, so the match is case-insensitive; the parent's original
 * casing is preserved on the way out). Everything else is dropped — including anything that merely
 * LOOKS harmless, which is exactly how a credential defeats a denylist.
 */
export const CHILD_ENV_ALLOWLIST: ReadonlySet<string> = new Set<string>([
  // — universal: without these the child cannot start or cannot find npm at all —
  "path", // resolves the node/npm binaries the child execs
  "home", // npm's cache + prefix resolution root on POSIX
  "tmpdir", // node/npm scratch space on POSIX (absent ⇒ the platform default)
  // — presentation only: npm formats its own progress/report output with these —
  "lang",
  "lc_all",
  "lc_ctype",
  "tz",
  // — Windows: the process cannot start, resolve an executable, or open a socket without these —
  "systemroot",
  "systemdrive",
  "windir",
  "comspec",
  "pathext",
  "appdata",
  "localappdata",
  "userprofile",
  "temp",
  "tmp",
  // — the deliberately SMALL npm/node config subset. Each is required for a real-world install
  //   (corporate mirror, custom global prefix, TLS-inspecting proxy) and none names a credential:
  "npm_config_registry", // the registry to install from (userinfo-gated below)
  "npm_config_prefix", // where `-g` installs — the CLI's own install root
  "npm_config_cache", // the package cache directory
  "npm_config_cafile", // a CA BUNDLE PATH (not an inline credential)
  "node_extra_ca_certs", // node-level CA bundle path — same corporate-TLS need
  "npm_config_proxy",
  "npm_config_https_proxy",
  "npm_config_noproxy",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  // DELIBERATELY ABSENT (each is a live hazard, not an oversight): `npm_config_userconfig` /
  // `npm_config_globalconfig` (point npm at a token-bearing npmrc — the userconfig is SET below from
  // a caller-supplied credential-free path, never inherited); `npm_config_strict_ssl` (a parent could
  // silently disable certificate verification for the install); `node_options` / `node_path` (arbitrary
  // code + module-resolution injection into the child); every credential-helper/agent socket path.
]);

/** Allowlisted names whose VALUE is a URL — npm accepts a SCHEMELESS proxy (`user:pass@host:port`). */
const URL_VALUED_ENV: ReadonlySet<string> = new Set<string>([
  "npm_config_registry",
  "npm_config_proxy",
  "npm_config_https_proxy",
  "npm_config_noproxy",
  "http_proxy",
  "https_proxy",
  "no_proxy",
]);

/** A leading `scheme://`. Scoping the userinfo check to URL-shaped values keeps a Windows PATH with
 * an `@scope` directory in it from being read as an authority. */
const URL_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;

/**
 * Does this value carry URL userinfo (`user:pass@host` / `user@host`)? Only the AUTHORITY is
 * inspected — the segment after the scheme and before the first `/`, `?` or `#` — so a path or query
 * containing `@` is not mistaken for a credential.
 */
function carriesUrlUserinfo(name: string, value: string): boolean {
  if (!URL_SCHEME.test(value) && !URL_VALUED_ENV.has(name)) return false;
  const authority = value.replace(URL_SCHEME, "").split(/[/?#]/, 1)[0] ?? "";
  return authority.includes("@");
}

/** Caller-supplied inputs the pure sanitizer cannot derive itself (this module touches no fs/process). */
export interface SanitizeChildEnvOptions {
  /**
   * Absolute path to a CREDENTIAL-FREE npm user config for the child to read INSTEAD of the invoking
   * user's `~/.npmrc` (which may hold a registry `_authToken`). Supplied by the caller because
   * building it is an fs concern; omitted ⇒ `npm_config_userconfig` is simply not set and npm falls
   * back to its default user config.
   */
  readonly npmUserConfigPath?: string;
}

/**
 * Build a least-privilege environment for the npm child (B7). The env is CONSTRUCTED from
 * `CHILD_ENV_ALLOWLIST`, not filtered out of the parent's: a denylist forwards every name it does not
 * happen to spell, and credentials reach a child under plenty of them (a `*_USERCONFIG` pointing at a
 * token-bearing npmrc, a credential-helper socket path, an unrelated secret under an innocuous name).
 * Three gates, in order:
 *   1. ALLOWLIST — the name must be listed (case-insensitive); anything else is dropped.
 *   2. SECRET NAME — `isSecretEnvKey` applies ON TOP of the allowlist (defence in depth: an
 *      allowlisted name that is nevertheless secret-shaped is still withheld, so a careless allowlist
 *      edit cannot open a credential path on its own).
 *   3. URL USERINFO — an allowlisted URL-valued variable carrying `user:pass@` is DROPPED, not masked:
 *      a masked URL would hand npm a broken registry/proxy, and a credential must never ride into the
 *      child inside one.
 * `npm_config_userconfig` is never inherited; it is SET from `options.npmUserConfigPath` when the
 * caller supplies one, so the child reads a credential-free user config instead of `~/.npmrc`.
 */
export function sanitizeChildEnv(env: NodeJS.ProcessEnv, options: SanitizeChildEnvOptions = {}): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    const name = key.toLowerCase();
    if (!CHILD_ENV_ALLOWLIST.has(name)) continue;
    if (isSecretEnvKey(key)) continue;
    if (carriesUrlUserinfo(name, value)) continue;
    out[key] = value;
  }
  if (options.npmUserConfigPath !== undefined) {
    out["npm_config_userconfig"] = options.npmUserConfigPath;
  }
  return out;
}

/** Is this env var name secret-bearing (and thus withheld from the npm child)? */
export function isSecretEnvKey(key: string): boolean {
  const lower = key.toLowerCase();
  if (lower.startsWith("agkit_")) return true;
  if (isSecretFieldName(key)) return true;
  if (lower.includes("_auth") || lower.includes("authtoken")) return true;
  return false;
}
