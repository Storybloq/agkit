// The INJECTABLE keychain seam (T-206, PL-19). All keychain access goes through
// `KeyringPort`; production wires `napiKeyringPort()` (a lazy wrapper around the
// native `@napi-rs/keyring` addon), and tests inject a fake whose `get`/`set`
// throw `KeyringUnavailableError` to SIMULATE a headless Linux box with no
// secret-service — asserting the loud two-remedy failure without a real backend.
//
// `@napi-rs/keyring` is a native `.node` addon: it is `external` in tsup and is
// LAZILY imported inside the port methods, so a local command (`version`) that
// never touches a credential never loads the addon.

/** The keychain backend is absent / unusable (no secret-service, dbus down, etc.). */
export class KeyringUnavailableError extends Error {
  override name = "KeyringUnavailableError";
  constructor(message = "OS keychain backend is unavailable") {
    super(message);
  }
}

/**
 * The one seam every keychain touch goes through.
 *   get   -> the stored secret, or null when the entry is simply ABSENT (backend
 *            healthy, nothing stored). Throws KeyringUnavailableError when the
 *            BACKEND is missing — the caller distinguishes "empty" from "broken".
 *   set   -> throws KeyringUnavailableError when the backend is missing.
 *   delete-> true if an entry was removed, false if none existed.
 */
export interface KeyringPort {
  get(service: string, account: string): Promise<string | null>;
  set(service: string, account: string, secret: string): Promise<void>;
  delete(service: string, account: string): Promise<boolean>;
}

// A minimal structural type for the native addon, declared locally so this file
// does not hard-depend on the addon's generated .d.ts resolving under `types:[node]`.
interface KeyringEntry {
  getPassword(): string | null;
  setPassword(password: string): void;
  deletePassword(): boolean;
}
interface KeyringModule {
  Entry: new (service: string, account: string) => KeyringEntry;
}

let cached: Promise<KeyringModule> | null = null;
async function loadNative(): Promise<KeyringModule> {
  cached ??= import("@napi-rs/keyring") as unknown as Promise<KeyringModule>;
  return cached;
}

// "Entry absent" is normally a null return from the sync API; on the versions
// that instead THROW a NoEntry error it carries keyring-rs's specific message. We
// match ONLY that narrow phrase and treat EVERY other throw as backend-absent —
// failing LOUD (§B-9: a broad "not found" match on a backend-unavailable error
// would silently downgrade to `none` instead of the required keychain_unavailable).
const NOT_FOUND = /no matching entry found in secure storage/i;
function isNotFound(err: unknown): boolean {
  const m = err instanceof Error ? err.message : String(err);
  return NOT_FOUND.test(m);
}

/** The production port: a lazy wrapper over the native addon. Never logs secrets. */
export function napiKeyringPort(): KeyringPort {
  return {
    async get(service, account) {
      let mod: KeyringModule;
      try {
        mod = await loadNative();
      } catch {
        throw new KeyringUnavailableError("failed to load the OS keychain addon");
      }
      try {
        return new mod.Entry(service, account).getPassword() ?? null;
      } catch (err) {
        if (isNotFound(err)) return null;
        // Fail SAFE: the message never contains the secret; keep it static.
        throw new KeyringUnavailableError();
      }
    },
    async set(service, account, secret) {
      let mod: KeyringModule;
      try {
        mod = await loadNative();
      } catch {
        throw new KeyringUnavailableError("failed to load the OS keychain addon");
      }
      try {
        new mod.Entry(service, account).setPassword(secret);
      } catch {
        throw new KeyringUnavailableError();
      }
    },
    async delete(service, account) {
      let mod: KeyringModule;
      try {
        mod = await loadNative();
      } catch {
        throw new KeyringUnavailableError("failed to load the OS keychain addon");
      }
      try {
        return new mod.Entry(service, account).deletePassword();
      } catch (err) {
        if (isNotFound(err)) return false;
        throw new KeyringUnavailableError();
      }
    },
  };
}
