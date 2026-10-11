-- Registered Microservice Workloads (Per-Flag Consumer Lifecycle)
CREATE TABLE IF NOT EXISTS services (
    name VARCHAR(128) NOT NULL,
    env VARCHAR(64) NOT NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'SILENT', 'RETIRED')),
    first_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen TIMESTAMPTZ NOT NULL,
    silent_since TIMESTAMPTZ,
    retired_at TIMESTAMPTZ,
    sdk_version VARCHAR(32) NOT NULL,
    PRIMARY KEY (name, env)
);

-- Daily Aggregated Flag Telemetry (HOT-optimized fillfactor, sorted key updates)
CREATE TABLE IF NOT EXISTS flag_usage_daily (
    flag_key VARCHAR(128) NOT NULL,
    env VARCHAR(64) NOT NULL,
    service VARCHAR(128) NOT NULL,
    variant VARCHAR(64) NOT NULL,
    usage_date DATE NOT NULL,
    eval_count BIGINT NOT NULL DEFAULT 0,
    first_seen TIMESTAMPTZ NOT NULL,
    last_seen TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (flag_key, env, service, variant, usage_date)
) WITH (fillfactor = 70);
