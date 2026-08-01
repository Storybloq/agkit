// The stored credential RECORD — field NAMES are pinned by N-011 §APX-E.4
// ("Stored credential record (field names, not values)"):
//   { issuer, client_id, access_token, access_expires_at, refresh_token,
//     grant_id, scopes, binding, schema:1 }
// The VALUES are secrets and never appear in any log/error (the T-205 redaction
// registry masks them in any envelope, and this module never echoes them).
//
// A strict runtime schema (deliverable 6 / review-hardening) gates every byte that
// enters `Ctx` from storage: bad JSON, a wrong `schema` version, a missing/empty
// token, or oversized fields become a teachable MalformedCredentialError instead
// of flowing into the process under a bare type assertion.
import { z } from "zod";
import { MalformedCredentialError } from "./errors";

/** Hard caps so an attacker-controlled file cannot exhaust memory via one field. */
const MAX_TOKEN = 8192;
const MAX_STR = 4096;

export const credentialRecordSchema = z
  .object({
    issuer: z.string().max(MAX_STR).default(""),
    client_id: z.string().max(MAX_STR).default(""),
    access_token: z.string().min(1, "access_token is required").max(MAX_TOKEN),
    access_expires_at: z.string().max(64).nullable().default(null),
    refresh_token: z.string().max(MAX_TOKEN).nullable().default(null),
    grant_id: z.string().max(MAX_STR).nullable().default(null),
    scopes: z.array(z.string().max(256)).max(512).default([]),
    binding: z.string().max(MAX_STR).nullable().default(null),
    schema: z.literal(1),
  })
  .strict();

export type CredentialRecord = z.infer<typeof credentialRecordSchema>;

/** The whole profile-keyed insecure-file document: `{ [profile]: CredentialRecord }`. */
export const credentialDocumentSchema = z.record(z.string(), credentialRecordSchema);
export type CredentialDocument = z.infer<typeof credentialDocumentSchema>;

/**
 * Build a minimal, VALID record from a bare access token (nothing else known).
 * Used when the CLI mints/stores just a token before the full OAuth record exists
 * (T-211/T-213 fill the rest). Bypasses the `issuer.min(1)` style constraints by
 * constructing directly, so a token-only credential is representable.
 */
export function recordFromToken(accessToken: string): CredentialRecord {
  return {
    issuer: "",
    client_id: "",
    access_token: accessToken,
    access_expires_at: null,
    refresh_token: null,
    grant_id: null,
    scopes: [],
    binding: null,
    schema: 1,
  };
}

/**
 * Parse + validate a stored record from its raw string form (keychain payload).
 * We ALWAYS write `JSON.stringify(record)`, so anything that is not a valid JSON
 * record is corruption — it fails LOUD (MalformedCredentialError), never masked by
 * a bare-token fallback that could ship a truncated blob as a bearer token.
 */
export function parseStoredRecord(raw: string): CredentialRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new MalformedCredentialError("stored credential is not a valid JSON record");
  }
  const result = credentialRecordSchema.safeParse(parsed);
  if (!result.success) throw new MalformedCredentialError("stored credential record is malformed");
  return result.data;
}

/** Parse + validate the whole profile-keyed document (insecure-file JSON). */
export function parseDocument(text: string): CredentialDocument {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new MalformedCredentialError("credentials file is not valid JSON");
  }
  const result = credentialDocumentSchema.safeParse(parsed);
  if (!result.success) throw new MalformedCredentialError("credentials file has a malformed record");
  return result.data;
}
