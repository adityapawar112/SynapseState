-- Incident & Audit Change Events (Powers synapse log pull-based attribution)
CREATE TABLE IF NOT EXISTS change_events (
    id BIGSERIAL PRIMARY KEY,
    event_type VARCHAR(64) NOT NULL CHECK (event_type IN ('LEASE_CREATED', 'LEASE_REVOKED', 'LEASE_SUPERSEDED', 'LEASE_EXPIRED', 'LEASE_PROMOTED', 'GIT_MERGE')),
    env VARCHAR(64) NOT NULL,
    flag_key VARCHAR(128),
    actor VARCHAR(128) NOT NULL,
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    payload JSONB NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_change_events_lookup ON change_events (env, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_change_events_flag ON change_events (flag_key, env, occurred_at DESC) WHERE flag_key IS NOT NULL;
