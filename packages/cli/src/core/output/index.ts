// Public surface of the serializer chokepoint (T-205, canonical L2-CLI-03). The
// shell (src/cli/) imports from here; nothing reaches a formatter without passing
// through `renderEnvelope`'s single upstream redaction pass.
export {
  buildSuccessEnvelope,
  buildErrorEnvelope,
  isErrorEnvelope,
  shownOnceSecrets,
  SHOWN_ONCE_META_KEY,
  type Envelope,
  type SuccessEnvelope,
  type ErrorEnvelope,
} from "./envelope";
export {
  renderEnvelope,
  emitSuccess,
  emitError,
  renderTakeoverErrorDoc,
  type RenderResult,
} from "./serialize";
export {
  resolveOutputConfig,
  defaultOutputConfig,
  sniffJsonFromArgv,
  fallbackOutputConfig,
  GLOBAL_OUTPUT_FLAGS,
  OutputFlagError,
  type OutputConfig,
  type OutputMode,
} from "./config";
export { UnknownFieldError, availableFields, projectFields } from "./project";
// T-227 S7 (req 9): the auto-sized data fence for TENANT free text. Exported from the chokepoint's
// public surface so any future human-readable renderer reuses THIS one instead of growing a second
// (drifting) fence — exactly the one-mechanism rule `redact` / `displaySafe` already follow.
export {
  fenceData,
  fenceLength,
  hasControlChars,
  isTenantFreeTextField,
  DATA_FENCE_LANGUAGE,
  DATA_FENCE_MARKER,
  type DataFenceOptions,
} from "./fence";
export { JqEvalError, runJq } from "./jq";
export { TemplateError, renderTemplate } from "./template";
export {
  redact,
  redactText,
  maskAuthorization,
  isMgmtToken,
  isPublishableExempt,
  REDACTED,
} from "./redaction";
export { ENVELOPE_VERSION } from "../../contract";
