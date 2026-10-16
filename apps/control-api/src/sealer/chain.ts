/**
 * Canonical audit ledger chain math and verification primitives.
 * Re-exported from @synapsestate/lease for shared use across control-api and SRE CLI.
 */
export {
  GENESIS_PREV_HASH,
  type AuditEventData,
  type AuditEventRecord,
  type ChainVerificationResult,
  canonicalizeAuditEvent,
  computeEventHash,
  verifySingleEvent,
  verifyAuditChain,
} from "@synapsestate/lease";
