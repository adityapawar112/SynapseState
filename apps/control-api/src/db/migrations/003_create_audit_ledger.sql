-- Asynchronous Staging Buffer for Audit Events (Zero request lock contention)
CREATE TABLE IF NOT EXISTS audit_pending (
    id BIGSERIAL PRIMARY KEY,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    actor VARCHAR(128) NOT NULL,
    event_type VARCHAR(64) NOT NULL,
    payload JSONB NOT NULL
);

-- Cryptographically Sealed Append-Only Audit Ledger
CREATE TABLE IF NOT EXISTS audit_events (
    seq BIGSERIAL PRIMARY KEY,
    ts TIMESTAMPTZ NOT NULL,
    actor VARCHAR(128) NOT NULL,
    event_type VARCHAR(64) NOT NULL,
    payload JSONB NOT NULL,
    prev_hash VARCHAR(64) NOT NULL,
    hash VARCHAR(64) NOT NULL
);
