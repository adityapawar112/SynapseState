# Runbook: Audit Sealer Stalled or Lagging

## Severity

- **Critical:** Fired when `synapse_audit_pending_age_seconds` exceeds 30 seconds for > 2 minutes.

## Symptoms

- Alert `SynapseAuditSealerLagging` firing.
- Unsealed events accumulating in `audit_pending` table without being sealed into `audit_events`.

## Triage & Investigation

1. **Check Sealer Advisory Lock:**
   - The sealer uses `pg_try_advisory_xact_lock(hashtext('synapse_audit_sealer'))`.
   - Check if an orphaned transaction or connection is holding the advisory lock:
     ```sql
     SELECT pid, mode, granted, query
     FROM pg_locks l
     JOIN pg_stat_activity a ON l.pid = a.pid
     WHERE locktype = 'advisory';
     ```
2. **Check Control API Logs for Sealer Exceptions:**
   ```bash
   kubectl logs -n synapse-system -l app.kubernetes.io/name=control-api | grep -i sealer
   ```
3. **Verify Database Disk & Write Performance:**
   - Check PostgreSQL write latency and tablespace utilization.
