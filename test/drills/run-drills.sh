#!/usr/bin/env bash
# ==============================================================================
# SynapseState Chaos Drills & Disaster Recovery Verification Harness
#
# Primary Specifications:
# - AGENTS.md §2 (Invariants 1, 2, 3)
# - docs/ARCHITECTURE.md §10 (Disaster Recovery & Air-Gap Fallback)
# - docs/ROADMAP.md §5 Phase 4 Deliverable 4.4
# ==============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

cd "${REPO_ROOT}"

echo "=============================================================================="
echo "⚡ SynapseState Chaos Drills & Disaster Recovery Verification Harness"
echo "=============================================================================="
echo "Target Milestone: Phase 4 Deliverable 4.4 (Failure Drills & Verification)"
echo "Working Directory: ${REPO_ROOT}"
echo "Node Runtime:      $(node -v)"
echo "Timestamp (UTC):   $(date -u +"%Y-%m-%dT%H:%M:%SZ")"
echo "------------------------------------------------------------------------------"

START_TIME=$(date +%s)

echo "▶ Executing Drill 1: Air-Gapped Emergency Lease Application..."
pnpm vitest run test/drills/drill1-airgap-override.test.ts

echo "------------------------------------------------------------------------------"
echo "▶ Executing Drill 2: Clock-Skew Injection & Dual-Clock Expiry..."
pnpm vitest run test/drills/drill2-clock-skew.test.ts

echo "------------------------------------------------------------------------------"
echo "▶ Executing Drill 3: Network Partition During Lease Revocation..."
pnpm vitest run test/drills/drill3-revocation-partition.test.ts

END_TIME=$(date +%s)
ELAPSED=$((END_TIME - START_TIME))

echo "=============================================================================="
echo "✅ All Chaos & Disaster Recovery Drills PASSED Successfully in ${ELAPSED}s!"
echo "=============================================================================="
echo "Architectural Invariants Verified:"
echo "  [PASS] Invariant 1: Fail-Safe Hot Path Delegation (Zero application crashes)"
echo "  [PASS] Invariant 2: Pinned Keyset Trust Root (Zero forged/revoked overrides)"
echo "  [PASS] Invariant 3: Dual-Clock Expiry (Zero leases survive past TTL deadline)"
echo "  [PASS] Threat Mitigation: Total Control API outage handled via air-gap"
echo "  [PASS] Threat Mitigation: Network partition during revocation bounded by TTL"
echo "  [PASS] Threat Mitigation: NTP rollback attacks thwarted by monotonic clock"
echo "=============================================================================="
