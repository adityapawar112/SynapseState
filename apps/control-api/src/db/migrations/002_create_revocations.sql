-- Signed Lease Revocations (Exact retention: expires_at mirrors lease target)
CREATE TABLE IF NOT EXISTS revocations (
    lease_id VARCHAR(32) PRIMARY KEY REFERENCES leases(lease_id),
    payload JSONB NOT NULL,
    sig TEXT NOT NULL,
    revoked_by_kid VARCHAR(128) NOT NULL,
    revoked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL -- Target lease expires_at + SKEW_TOLERANCE
);

CREATE INDEX IF NOT EXISTS idx_revocations_expires_at ON revocations (expires_at);

-- Signed Fast-Path Key Revocations
CREATE TABLE IF NOT EXISTS key_revocations (
    kid VARCHAR(128) PRIMARY KEY,
    payload JSONB NOT NULL,
    sig TEXT NOT NULL,
    revoked_by_kid VARCHAR(128) NOT NULL,
    revoked_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
