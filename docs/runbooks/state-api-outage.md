# Runbook: State API Outage & High Error Rate

## Severity

- **Critical (Fast Burn, 14.4x):** Immediate on-call pager notification.
- **Warning (Slow Burn, 6x):** Business-hours ticket notification.

## Symptoms

- Alert `SynapseStateApiAvailabilityFastBurn` or `SynapseStateApiAvailabilitySlowBurn` firing.
- HTTP 5xx responses returned on `GET /v1/sdk/state`.
- Client SDKs falling back to local cached state or delegate provider.

## Triage & Investigation

1. **Check Control API Pod Status:**
   ```bash
   kubectl get pods -n synapse-system -l app.kubernetes.io/name=control-api
   kubectl logs -n synapse-system -l app.kubernetes.io/name=control-api --tail=100
   ```
2. **Check Database Connectivity:**
   - Inspect PostgreSQL health in namespace `synapse-system`.
   - Verify connection pool gauges (`synapse_audit_pending_queue_size`).
3. **Verify Fail-Safe Invariant (ARCH §2 Invariant 1):**
   - Confirm application microservices continue evaluating flags fail-safe using local in-memory state and delegate providers.
4. **Air-Gapped Mitigation (if Control API remains down during an active incident):**
   - Generate an air-gapped emergency override ConfigMap using the SRE CLI:
     ```bash
     synapse lease emergency-apply --flag <key> --env prod --value <val> --ttl 30m --reason "<incident-id>" --out-file emergency-lease.yaml
     ```
   - Apply the emergency lease ConfigMap directly to the workload namespace:
     ```bash
     kubectl apply -f emergency-lease.yaml -n workloads
     ```
