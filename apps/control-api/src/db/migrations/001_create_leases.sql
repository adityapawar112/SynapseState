-- Core Flag Registry (Synchronized from Git flags/<env>/*.yaml)
CREATE TABLE IF NOT EXISTS flags (
    key VARCHAR(128) NOT NULL,
    env VARCHAR(64) NOT NULL,
    class VARCHAR(32) NOT NULL CHECK (class IN ('release', 'killswitch', 'permanent')),
    owner VARCHAR(128) NOT NULL,
    description TEXT,
    registry_version BIGINT NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (key, env)
);

-- Break-Glass Emergency Leases (Soft Reference to flags: no FK constraint)
CREATE TABLE IF NOT EXISTS leases (
    lease_id VARCHAR(32) PRIMARY KEY, -- ULID
    flag_key VARCHAR(128) NOT NULL,
    env VARCHAR(64) NOT NULL,
    payload JSONB NOT NULL,
    sig TEXT NOT NULL,
    state VARCHAR(32) NOT NULL CHECK (state IN ('ACTIVE', 'SUPERSEDED', 'REVOKED', 'EXPIRED', 'PROMOTED')),
    issued_at TIMESTAMPTZ NOT NULL,
    ttl_seconds INT NOT NULL CHECK (ttl_seconds > 0 AND ttl_seconds <= 86400),
    expires_at TIMESTAMPTZ NOT NULL,
    created_by_kid VARCHAR(128) NOT NULL,
    promote_pr_url TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    -- NOTE: Unconstrained flag_key/env guarantees emergency overrides never fail during catalog sync lag
);

-- Partial Unique Index: Only ONE active lease per flag per environment
CREATE UNIQUE INDEX IF NOT EXISTS idx_active_lease_per_flag_env 
ON leases (flag_key, env) 
WHERE state = 'ACTIVE';

CREATE INDEX IF NOT EXISTS idx_leases_expires_at 
ON leases (expires_at) 
WHERE state = 'ACTIVE';
