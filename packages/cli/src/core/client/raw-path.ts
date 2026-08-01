// Raw-door path validation (T-222 step 10b, S7.2 / C1 / m2). The raw wire door forwards an
// OPERATOR-controlled path under the management bearer, so this is the load-bearing boundary check.
// It validates the DECODED path (what the server actually routes on) and RE-ENCODES canonically from
// the validated segments, so "what we validate == what we send == what the server decodes" — closing
// the percent-encoding evasion (C1: `…/%6fauth/token` decodes to the OAuth token endpoint) and the
// decoded-control-byte evasion (m2: `..%00` decodes to a segment carrying a control byte).
//
// Ordering (each step fails CLOSED, never constructs a bogus URL):
//   a. reject empty / non-`/`-leading / `//`-prefixed;
//   b. reject control bytes, whitespace, backslash, `#` on the RAW string (pre-decode);
//   c. split off the query at the first `?`;
//   d. decode each path segment (malformed `%` => reject) and reject a decoded segment that is empty
//      (mid-path `//` / trailing `/`), `.` / `..` (traversal), contains `/` `\` control / whitespace,
//      OR still contains `%` after the decode — a residual `%` means the input was DOUBLE-encoded
//      (`%252e%252e`, `%256fauth`), and a double-decoding proxy/router between us and the server
//      would decode it a second time into a form our checks never saw. One decode, zero residue;
//   e. assert the DECODED path is within the management namespace AND NOT under the OAuth boundary;
//   f. re-encode canonically and assert the assembled URL's origin equals the approved origin.
//
// Every failure is the closed-set `usage_error` (no new code) with a STATIC message — the path may
// carry a mistyped secret, so nothing from it is interpolated into the error (hard constraint).
import { CliLocalError } from "../errors";
import { isWithinManagementNamespace, isUnderOauthBoundary } from "./management-namespace";

/** The validated raw path: the canonical (re-encoded) path to send, the decoded path, and the raw query. */
export interface ValidatedRawPath {
  /** Canonical percent-encoded absolute path (re-encoded from the validated decoded segments). */
  readonly canonicalPath: string;
  /** The fully decoded path the namespace/OAuth checks ran on (== what the server decodes). */
  readonly decodedPath: string;
  /** The raw query substring after the first `?` (empty when none) — canonicalized by raw-query.ts. */
  readonly rawQuery: string;
}

/** Does `s` contain a C0 control (<= 0x1f) or DEL (0x7f)? Code-point based (no regex escape ambiguity). */
function hasControlChar(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c <= 0x1f || c === 0x7f) return true;
  }
  return false;
}

const BACKSLASH = String.fromCharCode(0x5c);

/** Control bytes, whitespace, backslash, or `#` in the RAW (pre-decode) string. */
function hasForbiddenRawChar(raw: string): boolean {
  return hasControlChar(raw) || /\s/u.test(raw) || raw.includes(BACKSLASH) || raw.includes("#");
}

/** A decoded segment is illegal if empty, a traversal token, or carrying a slash/backslash/control/whitespace,
 * or if it STILL contains `%` after the one decode — residual percent means double-encoding, and any
 * double-decoding hop downstream would produce a path our namespace/OAuth checks never validated.
 * (Fail-closed: no management resource id legitimately contains a literal `%`.) */
function isIllegalDecodedSegment(seg: string): boolean {
  if (seg === "" || seg === "." || seg === "..") return true;
  if (seg.includes("/") || seg.includes(BACKSLASH)) return true;
  if (hasControlChar(seg) || /\s/u.test(seg)) return true;
  if (seg.includes("%")) return true;
  return false;
}

function rawPathError(detail: string): CliLocalError {
  return new CliLocalError("usage_error", {
    detail,
    hint: "supply an absolute path under /v1/management (outside the OAuth subtree)",
  });
}

/**
 * Validate + canonicalize a raw-door request path against the approved `origin`. Returns the
 * canonical path to send, the decoded path, and the raw query (which raw-query.ts canonicalizes).
 * Throws `usage_error` (static message) on any violation — no URL is ever constructed from a rejected path.
 */
export function validateRawPath(path: string, origin: string): ValidatedRawPath {
  // a. shape: must be a non-empty, single-leading-slash absolute path.
  if (typeof path !== "string" || path.length === 0) {
    throw rawPathError("the request path is required");
  }
  if (!path.startsWith("/")) {
    throw rawPathError("the request path must be absolute (start with a single '/')");
  }
  if (path.startsWith("//")) {
    throw rawPathError("the request path must not start with '//' (that names an authority, not a path)");
  }

  // b. pre-decode hazard classes on the RAW string (an origin-escaping backslash / whitespace / `#`
  //    fragment / control byte must never even reach the decoder).
  if (hasForbiddenRawChar(path)) {
    throw rawPathError("the request path contains an illegal character (whitespace, control, backslash, or '#')");
  }

  // c. split the query off at the FIRST `?`.
  const qIndex = path.indexOf("?");
  const rawPathPart = qIndex === -1 ? path : path.slice(0, qIndex);
  const rawQuery = qIndex === -1 ? "" : path.slice(qIndex + 1);

  // d. decode each segment and re-validate the DECODED form (catches %2f, %5c, %00, %2e%2e, ...).
  //    `rawPathPart` starts with "/"; slice(1) drops the leading empty so a mid-path `//` or a
  //    trailing `/` surfaces as an empty decoded segment (rejected below).
  const rawSegments = rawPathPart.slice(1).split("/");
  const decodedSegments: string[] = [];
  for (const rawSeg of rawSegments) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(rawSeg);
    } catch {
      throw rawPathError("the request path contains a malformed percent-encoding");
    }
    if (isIllegalDecodedSegment(decoded)) {
      throw rawPathError("the request path contains an illegal or non-canonical segment");
    }
    decodedSegments.push(decoded);
  }

  // e. boundary: the DECODED path must be inside the management namespace AND outside the OAuth subtree.
  const decodedPath = "/" + decodedSegments.join("/");
  if (!isWithinManagementNamespace(decodedPath)) {
    throw rawPathError("the request path is not within the management namespace");
  }
  if (isUnderOauthBoundary(decodedPath)) {
    throw rawPathError("the request path is within the OAuth subtree, which the raw door may not reach");
  }

  // f. re-encode canonically (server decodes this back to exactly `decodedPath`) + origin backstop.
  const canonicalPath = "/" + decodedSegments.map((s) => encodeURIComponent(s)).join("/");
  const base = origin.replace(/\/$/, "");
  let url: URL;
  let expectedOrigin: string;
  try {
    expectedOrigin = new URL(base).origin;
    url = new URL(base + canonicalPath);
  } catch {
    throw rawPathError("the approved API origin is not a valid URL");
  }
  if (url.origin !== expectedOrigin) {
    throw rawPathError("the request path would escape the approved API origin");
  }

  return { canonicalPath, decodedPath, rawQuery };
}
