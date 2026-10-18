-- Optimize flag_usage_daily lookups by environment, date, and service
-- Addresses PR 26 review finding I6
CREATE INDEX IF NOT EXISTS idx_flag_usage_daily_env_date ON flag_usage_daily (env, usage_date, service);
