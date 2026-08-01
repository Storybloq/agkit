// Public surface of the config/context subsystem (T-208, canonical L2-CLI-06). The
// shell (src/cli/) + the config/profile/status command handlers import from here.
// Everything is pure over injected seams (env, homeDir, cwd, keyring) — nothing
// reaches `process` — so the whole surface is deterministically testable.
export { DEFAULT_API_URL, resolveConfigDir, configFilePath, stateDirPath, type ConfigDirDeps } from "./dirs";
export { ConfigError } from "./errors";
export {
  configFileSchema,
  profileConfigSchema,
  parseConfig,
  emptyConfig,
  CONFIG_KEYS,
  CONFIG_KEY_NAMES,
  requireConfigKey,
  MAX_SECRET_SOURCES,
  secretSourceSchema,
  secretSourcesSchema,
  type ConfigData,
  type ProfileConfig,
  type ConfigKeySpec,
  type SecretSource,
} from "./schema";
// T-227 D0-H v2: the operator allowlist for indirect secret sources + the hardened,
// inode-bound file reader a `{source:"file"}` reference resolves through.
export {
  readSecretFile,
  readDeclaredSecretFile,
  assertFileSourceSupported,
  declaredSecretSources,
  declaredSecretSourcesFromConfig,
  activeSecretSourceProfile,
  findDeclaredEnv,
  findDeclaredFile,
  declareEnvSecretSource,
  declareFileSecretSource,
  removeSecretSource,
  identityToStored,
  identityFromStored,
  identityEquals,
  SECRET_SOURCE_MCP_EXCLUDE,
  type SecretFileIdentity,
  type SecretFileRead,
  type SecretFileReadOptions,
  type SecretSourceDeps,
  type SecretSourceWriteResult,
} from "./secret-sources";
export { loadConfig, saveConfig, type LoadedConfig } from "./config-file";
export { discoverRepoProject, repoProjectSchema, type RepoProject, type DiscoveredRepoProject } from "./repo-project";
export {
  resolveContext,
  type ContextSource,
  type Resolved,
  type ContextFlags,
  type ContextInputs,
  type ResolvedContext,
} from "./context";
export {
  hostOf,
  isDefaultApiUrl,
  DEFAULT_API_HOST,
  guardVerdict,
  withConfirmedApiUrl,
  apiUrlWarningBanner,
  enforceApiUrlGuard,
  type GuardStatus,
  type GuardVerdict,
  type GuardDeps,
  type GuardOutcome,
} from "./url-guard";
export {
  listProfiles,
  showProfile,
  useProfile,
  ensureProfileEntry,
  renameProfile,
  deleteProfile,
  type ProfileStoreDeps,
  type ProfileSummary,
  type ProfileListResult,
  type ProfileDetail,
  type ProfileUseResult,
  type ProfileRenameResult,
  type ProfileDeleteResult,
} from "./profile-store";
export {
  assembleStatus,
  probeHandshake,
  probePendingPlans,
  type StatusDeps,
  type StatusData,
  type StatusResult,
  type HandshakeProbe,
  type PendingPlansProbe,
  type SkewVerdict,
} from "./status";
export { readUpdateStamp, updateStampPath, type UpdateInfo } from "./state";
