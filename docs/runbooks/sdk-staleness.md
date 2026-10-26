# Runbook: SDK Fleet State or Keyset Staleness

## Severity

- **State Stale (Warning):** `synapse_sdk_state_age_seconds > 60` for > 5m.
- **Keyset Stale (Critical):** `synapse_sdk_keyset_age_seconds > 900` (15m ceiling).

## Symptoms

- Alert `SynapseStateStale` or `SynapseKeysetStale` firing.
- Workloads not picking up new state generation or unable to verify cryptographic signatures.

## Triage & Investigation

1. **Keyset Staleness (Critical - 15m ceiling):**
   - Keyset fallback cache expires at 15 minutes per ADR 0004 & ARCH §13.
   - Check if the mounted keyset volume (`/etc/synapse/keyset/keyset.json`) is missing or unreadable on the workload pods:
     ```bash
     kubectl exec -it <pod-name> -n workloads -- cat /etc/synapse/keyset/keyset.json
     ```
   - Verify ConfigMap `synapse-keyset` exists in the workload namespace.
2. **State Staleness (Warning - 60s):**
   - Check if the client application state-polling background loop encountered unhandled errors or rate limits:
     - Check `synapse_sdk_poll_errors_total` on the affected workload.
     - Check Control API endpoint `/v1/sdk/state` connectivity.
