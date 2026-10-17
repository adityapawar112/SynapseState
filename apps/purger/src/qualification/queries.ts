/**
 * SQL Rollup Engine for SynapseState Purger Quiescence Qualification.
 *
 * Implements telemetry aggregation queries across flag_usage_daily, services,
 * flags, and leases to construct typed FlagTelemetrySnapshots for qualification.
 *
 * Conforms to docs/ARCHITECTURE.md §9.1 and ADR 0007.
 */

import { DEFAULT_MIN_WINDOW_DAYS } from "./engine.js";
import type {
  ConsumerServiceEvaluation,
  FlagTelemetrySnapshot,
  Queryable,
  RawRollupRow,
  RollupQueryOptions,
  VariantEvaluation,
} from "./types.js";

/**
 * Builds the parameterized SQL rollup query aggregating flag telemetry,
 * consumer service statuses, flag classifications, and active emergency leases.
 */
export function buildQuiescenceRollupQuery(options?: RollupQueryOptions): {
  text: string;
  values: unknown[];
} {
  const windowDays = options?.windowDays ?? DEFAULT_MIN_WINDOW_DAYS;
  const env = options?.env ?? null;
  const flagKey = options?.flagKey ?? null;

  const text = `
WITH target_flags AS (
    SELECT key AS flag_key, env
    FROM flags
    WHERE ($2::text IS NULL OR env = $2)
      AND ($3::text IS NULL OR key = $3)
    UNION
    SELECT flag_key, env
    FROM flag_usage_daily
    WHERE ($2::text IS NULL OR env = $2)
      AND ($3::text IS NULL OR flag_key = $3)
),
active_leases AS (
    SELECT flag_key, env, COUNT(*) AS active_count
    FROM leases
    WHERE state = 'ACTIVE'
    GROUP BY flag_key, env
),
usage_window AS (
    SELECT
        flag_key,
        env,
        service,
        variant,
        eval_count,
        first_seen,
        last_seen
    FROM flag_usage_daily
    WHERE usage_date >= CURRENT_DATE - ($1 || ' days')::INTERVAL
      AND ($2::text IS NULL OR env = $2)
      AND ($3::text IS NULL OR flag_key = $3)
),
variant_agg AS (
    SELECT
        flag_key,
        env,
        variant,
        SUM(eval_count)::bigint AS eval_count,
        MIN(first_seen) AS first_seen,
        MAX(last_seen) AS last_seen
    FROM usage_window
    GROUP BY flag_key, env, variant
),
service_agg AS (
    SELECT
        uw.flag_key,
        uw.env,
        uw.service,
        COALESCE(s.status, 'SILENT') AS status,
        SUM(uw.eval_count)::bigint AS eval_count,
        MAX(uw.last_seen) AS last_seen
    FROM usage_window uw
    LEFT JOIN services s ON s.name = uw.service AND s.env = uw.env
    GROUP BY uw.flag_key, uw.env, uw.service, s.status
)
SELECT
    tf.flag_key,
    tf.env,
    f.class AS flag_class,
    f.created_at AS flag_created_at,
    COALESCE(al.active_count, 0) > 0 AS has_active_lease,
    COALESCE(
        (
            SELECT json_agg(
                json_build_object(
                    'variant', va.variant,
                    'evalCount', va.eval_count,
                    'firstSeen', va.first_seen,
                    'lastSeen', va.last_seen
                )
            )
            FROM variant_agg va
            WHERE va.flag_key = tf.flag_key AND va.env = tf.env
        ),
        '[]'::json
    ) AS variants,
    COALESCE(
        (
            SELECT json_agg(
                json_build_object(
                    'serviceName', sa.service,
                    'status', sa.status,
                    'evalCount', sa.eval_count,
                    'lastSeen', sa.last_seen
                )
            )
            FROM service_agg sa
            WHERE sa.flag_key = tf.flag_key AND sa.env = tf.env
        ),
        '[]'::json
    ) AS services
FROM target_flags tf
LEFT JOIN flags f ON f.key = tf.flag_key AND f.env = tf.env
LEFT JOIN active_leases al ON al.flag_key = tf.flag_key AND al.env = tf.env
GROUP BY tf.flag_key, tf.env, f.class, f.created_at, al.active_count
ORDER BY tf.flag_key ASC, tf.env ASC;
  `.trim();

  return {
    text,
    values: [windowDays, env, flagKey],
  };
}

/**
 * Maps a single raw database row from the quiescence rollup query
 * into a typed FlagTelemetrySnapshot.
 */
export function mapRowToFlagTelemetrySnapshot(
  row: RawRollupRow,
  windowDays: number = DEFAULT_MIN_WINDOW_DAYS,
): FlagTelemetrySnapshot {
  const rawVariants = Array.isArray(row.variants) ? row.variants : [];
  const rawServices = Array.isArray(row.services) ? row.services : [];

  const variants: VariantEvaluation[] = rawVariants.map((v) => ({
    variant: v.variant,
    evalCount: Number(v.evalCount) || 0,
    ...(v.firstSeen ? { firstSeen: new Date(v.firstSeen).toISOString() } : {}),
    ...(v.lastSeen ? { lastSeen: new Date(v.lastSeen).toISOString() } : {}),
  }));

  const services: ConsumerServiceEvaluation[] = rawServices.map((s) => ({
    serviceName: s.serviceName,
    status: s.status,
    evalCount: Number(s.evalCount) || 0,
    ...(s.lastSeen ? { lastSeen: new Date(s.lastSeen).toISOString() } : {}),
  }));

  // Identify earliest firstSeen and latest lastSeen across all recorded variants
  let firstSeen: string | undefined;
  let lastSeen: string | undefined;

  for (const v of variants) {
    if (v.firstSeen) {
      if (
        !firstSeen ||
        new Date(v.firstSeen).getTime() < new Date(firstSeen).getTime()
      ) {
        firstSeen = v.firstSeen;
      }
    }
    if (v.lastSeen) {
      if (
        !lastSeen ||
        new Date(v.lastSeen).getTime() > new Date(lastSeen).getTime()
      ) {
        lastSeen = v.lastSeen;
      }
    }
  }

  return {
    flagKey: row.flag_key,
    env: row.env,
    ...(row.flag_class ? { flagClass: row.flag_class } : {}),
    hasActiveLease: Boolean(row.has_active_lease),
    windowDays,
    ...(firstSeen ? { firstSeen } : {}),
    ...(lastSeen ? { lastSeen } : {}),
    variants,
    services,
  };
}

/**
 * Executes the quiescence rollup query against the provided database client
 * and returns the mapped FlagTelemetrySnapshots.
 */
export async function fetchFlagTelemetrySnapshots(
  db: Queryable,
  options?: RollupQueryOptions,
): Promise<FlagTelemetrySnapshot[]> {
  const query = buildQuiescenceRollupQuery(options);
  const result = await db.query<RawRollupRow>(query.text, query.values);
  const windowDays = options?.windowDays ?? DEFAULT_MIN_WINDOW_DAYS;
  return result.rows.map((row) =>
    mapRowToFlagTelemetrySnapshot(row, windowDays),
  );
}
