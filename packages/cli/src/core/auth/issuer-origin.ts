// Shared issuer-origin validation for stored-credential revocation (T-213 review X1 + round 2).
// The ONLY origin a stored token may be presented to for RFC 7009 revocation is the record's OWN
// VALIDATED issuer — never the currently guard-approved API URL (if the profile's API URL changed
// between logins, sending the old secret there would be a cross-origin credential disclosure AND
// leave the real grant live), and never a raw, unvalidated issuer string from disk.
//
// ONE implementation, both callers import it: `login` (the re-login orphan-grant revoke) and
// `logout` (the pre-clear revoke). The rule mirrors open-url/as-metadata: `https:`, or cleartext
// `http:` to a LITERAL loopback IP only (127.0.0.1 / ::1 / [::1] — the hostname `localhost` is
// rejected: it can DNS-resolve off-box), and never a URL carrying userinfo.

/**
 * Validate a stored record's `issuer` and return its origin, or null when the issuer is missing,
 * empty, malformed, userinfo-bearing, or non-https-non-loopback — the caller must then SKIP remote
 * revocation entirely (warn; the token is sent NOWHERE).
 */
export function validatedIssuerOrigin(issuer: unknown): string | null {
  if (typeof issuer !== "string" || issuer.length === 0) return null;
  let u: URL;
  try {
    u = new URL(issuer);
  } catch {
    return null;
  }
  if (u.username !== "" || u.password !== "") return null;
  const h = u.hostname.toLowerCase();
  const loopback = h === "127.0.0.1" || h === "::1" || h === "[::1]";
  if (u.protocol !== "https:" && !(u.protocol === "http:" && loopback)) return null;
  return u.origin;
}
