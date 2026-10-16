import { canonicalizeJson } from "./canonicalize.js";
import { CHECKPOINT_DOMAIN_PREFIX } from "./domains.js";
import {
  type CheckpointPayload,
  type CheckpointEnvelope,
  CheckpointEnvelopeSchema,
  type Keyset,
} from "./schema.js";
import {
  signEnvelope,
  verifyEnvelope,
  type PrivateKeyInput,
  type PublicKeyInput,
  type AsyncSigner,
} from "./crypto.js";
import { getKey, canSignCheckpoint } from "./keyset.js";

/**
 * Signs an audit checkpoint payload with Ed25519 using domain separation prefix.
 */
export function signCheckpoint(
  payload: CheckpointPayload,
  privateKey: PrivateKeyInput,
): CheckpointEnvelope {
  return signEnvelope(CHECKPOINT_DOMAIN_PREFIX, payload, privateKey);
}

/**
 * Verifies an audit checkpoint envelope against an Ed25519 public key.
 */
export function verifyCheckpoint(
  envelope: CheckpointEnvelope,
  publicKey: PublicKeyInput,
): boolean {
  return verifyEnvelope(CHECKPOINT_DOMAIN_PREFIX, envelope, publicKey);
}

/**
 * Signs an audit checkpoint payload using an asynchronous signer (e.g. KMS, HSM, or encrypted keyfile).
 */
export async function signCheckpointWithSigner(
  payload: CheckpointPayload,
  signer: AsyncSigner & { kid?: string },
): Promise<CheckpointEnvelope> {
  if (signer.kid && signer.kid !== payload.kid) {
    throw new Error(
      `Signer kid "${signer.kid}" does not match checkpoint payload kid "${payload.kid}"`,
    );
  }

  const canonical = canonicalizeJson(payload);
  const messageBuffer = Buffer.concat([
    Buffer.from(CHECKPOINT_DOMAIN_PREFIX, "utf8"),
    Buffer.from(canonical, "utf8"),
  ]);

  const sig = await signer.sign(messageBuffer);
  const envelope: CheckpointEnvelope = { payload, sig };
  return CheckpointEnvelopeSchema.parse(envelope);
}

/**
 * Cryptographically verifies an audit checkpoint envelope against a trusted keyset while enforcing:
 * 1. Pinned keyset existence (kid exists in keyset)
 * 2. Active status (status === "active")
 * 3. Key authorization policy (canSignCheckpoint)
 * 4. Ed25519 signature validity
 */
export function verifyCheckpointWithKeyset(
  envelope: CheckpointEnvelope,
  keyset: Keyset,
): boolean {
  try {
    const kid = envelope.payload.kid;
    const key = getKey(keyset, kid);
    if (!key) {
      return false;
    }
    if (!canSignCheckpoint(key)) {
      return false;
    }
    return verifyCheckpoint(envelope, key.public_key);
  } catch {
    return false;
  }
}
