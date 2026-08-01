// `--template <tpl>` — a MINIMAL dot-path templating language (T-205, canonical
// L2-CLI-03, deliverable 3). Supports ONLY `{{.a.b}}` and `{{.}}`, one line per
// array item. It is FORBIDDEN to grow this into an expression language: pipes,
// operators, brackets, functions all throw. Power users are routed to `--jq`.

/** Thrown for a malformed template or any non-dot-path token. */
export class TemplateError extends Error {
  override name = "TemplateError";
}

// A `{{ ... }}` token. The inner text must be a dot-path (`.` or `.a.b.c`).
const TOKEN = /\{\{\s*([^}]*?)\s*\}\}/g;
const FIELD_SEGMENT = /^[A-Za-z0-9_-]+$/;

/**
 * Render `data` with `tpl`. If `data` is an array, the template is applied to
 * EACH item, one line per item; otherwise a single line.
 */
export function renderTemplate(data: unknown, tpl: string): string {
  if (Array.isArray(data)) return data.map((item) => applyLine(tpl, item)).join("\n");
  return applyLine(tpl, data);
}

function applyLine(tpl: string, item: unknown): string {
  return tpl.replace(TOKEN, (_full, expr: string) => stringifyLeaf(resolvePath(item, expr)));
}

function resolvePath(root: unknown, expr: string): unknown {
  const path = expr.trim();
  if (path === ".") return root;
  if (!path.startsWith(".")) {
    throw new TemplateError(`template token must be a dot-path starting with '.': '{{${expr}}}'`);
  }

  let current: unknown = root;
  for (const segment of path.slice(1).split(".")) {
    if (segment === "") {
      throw new TemplateError(`empty path segment in template token '{{${expr}}}'`);
    }
    if (!FIELD_SEGMENT.test(segment)) {
      // Anything that isn't a plain field name (pipe, bracket, operator, space)
      // is an expression — deliberately unsupported. Route the user to --jq.
      throw new TemplateError(
        `--template supports only dot-paths (e.g. '{{.a.b}}'); '${segment}' is not a field name — use --jq for expressions`,
      );
    }
    if (current !== null && typeof current === "object" && !Array.isArray(current) &&
        Object.prototype.hasOwnProperty.call(current, segment)) {
      current = (current as Record<string, unknown>)[segment];
    } else {
      return undefined;
    }
  }
  return current;
}

function stringifyLeaf(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}
