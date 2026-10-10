/**
 * Authoritative cryptographic domain separation prefixes (RFC 8785 + Ed25519).
 * Guarantees signatures cannot be transplanted across protocol message types.
 */
export const LEASE_DOMAIN_PREFIX = "synapsestate/lease/v1\n";
export const REVOCATION_DOMAIN_PREFIX = "synapsestate/revocation/v1\n";
export const KEYREVOCATION_DOMAIN_PREFIX = "synapsestate/keyrevocation/v1\n";
