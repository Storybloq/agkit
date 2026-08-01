// The `secret-source` noun's two shared leaves (T-227 S5b): the injected-deps builder every verb
// hands the core operations, and the DECLARATION VIEW every verb returns.
//
// THE VIEW IS AN ALLOWLIST, NOT A PASSTHROUGH. A declaration holds no secret material by
// construction (it is a NAME or a PATH plus the approved inode identity), but the envelope is still
// enumerated member by member here rather than forwarding whatever `SecretSource` happens to carry:
// this noun's whole job is to describe where secrets come FROM, so a future field on that shape must
// be a decision made here, not something that appears in output because a struct grew.
//
// `dev`/`ino` are DELIBERATELY not rendered. They are the anti-swap identity, they mean nothing to an
// operator reading a list, and their absence keeps the output stable when a file is re-approved.
import { requireRuntime, type Ctx } from "../types";
import type { SecretSource, SecretSourceDeps } from "../../core/config";

/** The injected seams the declaration store reads/writes — env + homeDir locate the config file,
 *  cwd + flags resolve WHICH profile's allowlist applies (the same precedence chain as every other
 *  context value). Read off the runtime seam the shell injects; never `process`. */
export function secretSourceDeps(ctx: Ctx): SecretSourceDeps {
  const runtime = requireRuntime(ctx);
  return { env: runtime.env, homeDir: runtime.homeDir, cwd: runtime.cwd, flags: runtime.flags };
}

/** One rendered declaration: the kind plus the single identifier that kind is named by. */
export interface SecretSourceView {
  readonly kind: "env" | "file";
  readonly name: string | null;
  readonly path: string | null;
}

/** Render a declaration list for the envelope — declarations only, never a value, never content. */
export function viewSecretSources(sources: readonly SecretSource[]): SecretSourceView[] {
  return sources.map((source) =>
    source.kind === "env"
      ? { kind: "env", name: source.name, path: null }
      : { kind: "file", name: null, path: source.path },
  );
}
