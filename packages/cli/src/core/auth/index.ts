// Public surface of the credential chain (T-206, canonical L2-CLI-05). The shell
// (src/cli/) + handlers import from here. The keychain stays behind the injectable
// `KeyringPort`; nothing here reaches a real backend except `napiKeyringPort()`.
export {
  resolveCredential,
  readCredentialRecord,
  readStoredCredentialRecord,
  storeCredential,
  KEYCHAIN_SERVICE,
  type StoreOptions,
  type ResolvedRecord,
} from "./chain";
export {
  runBrowserLogin,
  runDeviceLogin,
  LoginFlowError,
  type LoginIoSeams,
  type LoginParams,
  type LoginFlowResult,
} from "./login-flow";
export {
  NO_CREDENTIAL,
  type CredentialSource,
  type ResolvedCredential,
  type CredentialDeps,
  type SpawnFn,
  type SpawnedChild,
} from "./types";
export { napiKeyringPort, KeyringUnavailableError, type KeyringPort } from "./keyring";
export {
  KeychainUnavailableError,
  InsecureStorageRefusedError,
  InsecureFilePermissionsError,
  MalformedCredentialError,
  KEYCHAIN_UNAVAILABLE_MESSAGE,
  KEYCHAIN_UNAVAILABLE_REMEDIES,
} from "./errors";
export {
  credentialRecordSchema,
  recordFromToken,
  type CredentialRecord,
  type CredentialDocument,
} from "./record";
export {
  insecureCredentialsPath,
  writeInsecureRecord,
  readInsecureRecord,
  removeInsecureRecord,
  copyInsecureRecord,
  listInsecureProfiles,
  type InsecureFileDeps,
} from "./insecure-file";
export { validatedIssuerOrigin } from "./issuer-origin";
export { runCredentialHelper, HELPER_TIMEOUT_MS, HELPER_SLOW_MS, type HelperRunDeps } from "./helper";
export { insecureStorageSurface, INSECURE_WARNING_BANNER, type InsecureSurface } from "./warning";
export {
  isCI,
  requiresDoubleOptIn,
  insecureDoubleOptInSatisfied,
  resolveProfile,
  readEnvToken,
  readHelperCommand,
  readEnvProfile,
  readEnvProject,
  readEnvApiUrl,
  readConfigDirEnv,
  readXdgConfigHome,
  apiUrlConfirmedEnv,
} from "./env";
