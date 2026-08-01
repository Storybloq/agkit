// `--jq <expr>` engine seam (T-205, canonical L2-CLI-03, deliverable 3 + the jq
// requirement). Uses a BUNDLED jq — NO system `jq` on PATH, ever.
//
// Engine: `jq-wasm` real jq 1.8.2 compiled to WebAssembly, imported via its
// `/inline` entry, which embeds the `.wasm` as a base64 string INSIDE the JS
// module. tsup/esbuild therefore bundles the whole engine into `dist/` with no
// separate `.wasm` asset to whitelist — it ships in the pack tarball (dist/**)
// and runs from `node dist/cli.js`. The import is DYNAMIC so the ~1.3MB engine
// loads only when `--jq` is actually used (it never touches the hot startup path
// of `agkit version` / plain json / human output).

/** Thrown when a jq expression fails to compile or evaluate. */
export class JqEvalError extends Error {
  override name = "JqEvalError";
}

type JqRawResult = { stdout: string; stderr: string; exitCode: number };
type JqRawFn = (data: unknown, filter: string, args?: string[]) => Promise<JqRawResult>;

let rawFnPromise: Promise<JqRawFn> | null = null;

/** Load (once) the bundled WASM jq's `raw` entry — the faithful jq stdout path. */
async function loadRaw(): Promise<JqRawFn> {
  if (!rawFnPromise) {
    rawFnPromise = import("jq-wasm/inline").then((mod) => (mod as { raw: JqRawFn }).raw);
  }
  return rawFnPromise;
}

/**
 * Evaluate `filter` against `data` with the bundled jq. Returns jq's exact stdout
 * (one result per line, pretty by default; whitespace-stripped when `compact`).
 * A jq compile/eval failure becomes a `JqEvalError`.
 */
export async function runJq(
  data: unknown,
  filter: string,
  opts: { compact?: boolean } = {},
): Promise<string> {
  const raw = await loadRaw();
  let result: JqRawResult;
  try {
    result = await raw(data, filter, opts.compact ? ["-c"] : []);
  } catch (err) {
    throw new JqEvalError(`jq evaluation failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (result.exitCode !== 0) {
    const firstLine = (result.stderr || "jq evaluation failed").split("\n")[0] ?? "jq evaluation failed";
    throw new JqEvalError(firstLine.replace(/^jq:\s*(error:\s*)?/, ""));
  }
  return result.stdout;
}
