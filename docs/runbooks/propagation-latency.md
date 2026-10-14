# Runbook: Lease Propagation Latency Degraded

## Severity
- **Warning:** Fired when p95 latency of `synapse_lease_propagation_seconds` exceeds 10s for > 5 minutes.

## Symptoms
- Alert `SynapseLeasePropagationDegraded` firing.
- Delayed delivery of break-glass emergency leases to client SDKs.

## Triage & Investigation
1. **Inspect Control API Latency & Long-Polling Connections:**
   - Check Grafana panel "State Poll Duration & Request Rate by Status Code".
   - Check if long-polling connections (`wait=30s`) are timing out or backing up.
2. **Check Client Network & Ingress:**
   - Verify network latency and HTTP proxy timeouts between `workloads` and `synapse-system`.
   - Verify Traefik ingress route health:
     ```bash
     kubectl get ingress -n synapse-system
     ```
3. **Check Client CPU Throttling:**
   - Check if client pods are throttling or experiencing heavy garbage collection pauses.
