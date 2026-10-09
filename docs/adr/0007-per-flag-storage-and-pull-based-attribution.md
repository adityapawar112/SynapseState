# 7. Per-Flag Directory Storage and Pull-Based Incident Attribution

Date: 2026-10-09  
Status: Accepted  

---

## Context

Operational stability and incident ergonomics require solving two acute workflows:
1. **Git Promotion Collisions:** Storing all flag configurations in a single monolithic `flags.yaml` registry caused Git merge collisions when independent SREs promoted overrides on different flags concurrently. Moving to per-flag files removes collision risks, but requires handling Kubernetes ConfigMap naming constraints (`[-._a-zA-Z0-9]+`), case-sensitivity collisions on developer filesystems (e.g. Windows vs. Linux), single-file delegate provider ingestion, and clear boundaries for non-Git flag providers.
2. **Incident Attribution Complexity:** Implementing push-based webhooks from Alertmanager required complex webhook parsers, Grafana service tokens, and chat glue before validating core attribution value. Furthermore, relying entirely on the Control API during an incident created a single point of failure.

---

## Decision

We chose **per-flag directory storage with build-time merging** and a **pull-based `synapse log` investigation workflow**:

1. **Per-Flag Directory Storage Layout:**
   - Flag definitions live in individual files under `flags/<env>/<flag_key>.yaml`.
   - **Charset Invariant:** Flag keys must match regex `^[a-z0-9]([-a-z0-9]*[a-z0-9])?$` (lowercase alphanumeric and hyphens). This satisfies Kubernetes ConfigMap key constraints and prevents file collisions on case-insensitive filesystems (Windows/macOS). CI lints enforce `filename == key`.
   - **Schema Unification:** Each `<flag_key>.yaml` houses both governance registry metadata (`class`, `owner`, `description`) and delegate variant definitions (`variants`, `defaultVariant`).
   - **Delegate Single-File Merging:** For OpenFeature delegate providers requiring a single file path rather than a directory watcher, a build step merges `flags/<env>/*.yaml` into a single `dist/<env>/flags.json` ConfigMap artifact.
   - **Stale PR Conflict Handling:** Concurrent promotions on different flags never collide. If two promotions target the same flag, the Control API flags the second PR as a stale conflict, prompting automated rebase or human resolution.
   - **Provider Scope (v1):** Automated Git promotion (`synapse promote`) is strictly scoped to Git-backed providers (`flagd` in-process, JSON/YAML file providers). For SaaS or external-database providers (such as Unleash), baselines are managed externally; automated promotion to Git is out of scope for v1.
2. **Pull-Based Incident Attribution via `synapse log`:**
   - Rather than relying on push webhooks, responders run:
     ```bash
     synapse log --service checkout-service --since 30m [--offline] [--json]
     ```
   - **API Change Feed:** The Control API records Git merge events and lease lifecycle transitions in a dedicated `change_events` table, queried via `GET /v1/changes`, keeping GitHub credentials off operator workstations.
   - **Shared Pure Ranker:** Attribution ranking is implemented as a deterministic pure function in a shared core package:
     ```typescript
     export function rankSuspects(
       events: ChangeEvent[], 
       evaluations: FlagEvaluationRecord[], 
       targetService: string
     ): RankedSuspect[];
     ```
     Scoring correlates temporal recency with service-specific evaluation volume from `flag_usage_daily`.
   - **Offline Mode:** The CLI supports `--offline`, reading local Git clone commits and local lease files directly when the Control API is offline, preventing single points of failure during outages.
   - **Type-Aware Suggestions:** Suggested mitigation overrides inspect flag schemas or telemetry history to suggest valid types (e.g. `--value off` or `--value false`) rather than naively templating boolean `false`.
   - **Extension Seam:** CLI supports `--json`, allowing future Alertmanager webhooks or Slack chatops bots to reuse the ranking engine without refactoring.

---

## Consequences

### Positive
* Zero Git merge conflicts across independent flag promotions.
* Attribution operates reliably both online and offline during major control-plane outages.
* Eliminates third-party webhook glue, parsers, and chat tokens from the MVP.
* Clean separation of concerns with a reusable, pure ranking engine.

### Negative
* OpenFeature delegate providers requiring a single file path require a build-time merge step (`flags/<env>/*.yaml` $\to$ `dist/<env>/flags.json`).
* Automated promotion in v1 requires a Git-backed baseline provider.
