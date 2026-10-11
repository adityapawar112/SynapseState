-- API Service & Automation Tokens
CREATE TABLE IF NOT EXISTS api_tokens (
    token_id VARCHAR(32) PRIMARY KEY,
    token_hash VARCHAR(64) NOT NULL, -- SHA-256
    service_name VARCHAR(128) NOT NULL,
    env VARCHAR(64) NOT NULL,
    roles TEXT[] NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    rotated_at TIMESTAMPTZ
);
