// Managed ATS read-only tool host contract v1: public surface.
//
// Closed validators, golden-vector-pinned digests and Ed25519 checks for the
// E1 schema bundle in contracts/managed-ats-tool-host/v1. Nothing here opens a
// transport, performs I/O, registers a tool or grants execution authority.
// Spec: docs/specs/2026-09-22-managed-ats-tool-host-v1.md. Guide: docs/CONTRACTS.md section 5.

export * from "./vocabulary.js";
export { ToolHostContractError } from "./errors.js";
export { parseFrame } from "./strict_json.js";
export {
  accountScopeDigest, argumentsDigest, digestFor as commonDigest, ed25519PublicKey, ed25519Sign, ed25519Verify,
  preimage as digestPreimage, schemaDigest, workspaceBindingDigest, type WorkspaceStatusBinding,
} from "./digest.js";
export { validateTrustDocument, type TrustDocumentV1, type TrustKeyV1 } from "./trust.js";
export { hostOpenPreimage, validateDeviceProof, validateHostOpenProof, type DeviceProofV1, type HostOpenProofV1 } from "./device.js";
export { validateObserverReceipt, validateRuntimeCapability, type ObserverReceiptV1, type RuntimeCapabilityV1 } from "./ats_channel.js";
export { validateRegistry, type ToolEntryV1, type ToolRegistryManifestV1 } from "./registry.js";
export { validateHostLease, type HostSessionLeaseV1 } from "./lease.js";
export { validateCancellation, validateInvocation, type ToolCancellationV1, type ToolInvocationV1 } from "./invocation.js";
export { validateResult, type ResultErrorV1, type ToolResultV1 } from "./result.js";
export { validateWorkspaceStatus, validateWorkspaceStatusInput, type WorkspaceStatusV1 } from "./workspace_status.js";
export {
  assertE1CanaryRegistry, checkCancellation, checkCapabilityReceipt, checkInvocation, checkLeaseBinding, checkResult,
  checkToolArguments, checkToolPayload, type CapabilityExpectation,
} from "./cross.js";
