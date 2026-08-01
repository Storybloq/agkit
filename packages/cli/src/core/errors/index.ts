// Public surface of the error taxonomy + teachable renderer (T-207, canonical
// L2-CLI-04). The shell (src/cli/), the serializer chokepoint (src/core/output/),
// and future id-bearing commands import from here.
export { EXIT, EXIT_CODES, isExitCode, type ExitCode } from "./exit-codes";
export {
  CLI_LOCAL_CODES,
  CLI_LOCAL_REGISTRY,
  isCliLocalCode,
  CliLocalError,
  AmbiguousPrefixError,
  type CliLocalCode,
  type CliCodeSpec,
} from "./cli-codes";
export { resolveIdPrefix } from "./prefix";
export {
  WIRE_ERROR_TABLE,
  WIRE_ERROR_CODES,
  MANAGEMENT_ERRORS_VERSION,
  isWireCode,
  type RetryClass,
  type WireErrorSpec,
} from "./wire-table";
export {
  classifyWireProblem,
  WireProblemError,
  type WireProblem,
  type WireClassification,
  type StatusClass,
} from "./wire-classify";
export {
  cliLocalErrorEnvelope,
  wireErrorEnvelope,
  allowlistedWireErrorEnvelope,
  retryableTransportEnvelope,
  PreClassifiedError,
  type ClassifiedError,
  type CliLocalOverrides,
  type WireErrorOptions,
  type AllowlistedWireErrorOptions,
} from "./problem";
export { classifyThrownError, commandPathFromArgv, safeErrorMessage, type ClassifyOpts } from "./classify";
