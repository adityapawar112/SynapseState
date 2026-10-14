/**
 * Pluggable Signer interface for SynapseState operator key management.
 * Spec: docs/ARCHITECTURE.md §1
 */
export interface Signer {
  /**
   * Pinned key identifier (kid) matching ^[A-Za-z0-9_-]{1,64}$
   */
  readonly kid: string;

  /**
   * Signs a message buffer using the signer's private key.
   * Returns a 64-byte Ed25519 signature encoded as base64url.
   */
  sign(message: Uint8Array): Promise<string>;

  /**
   * Optional helper to retrieve the signer's 32-byte Ed25519 public key as a 64-character lowercase hex string.
   */
  getPublicKey?(): Promise<string> | string;
}
