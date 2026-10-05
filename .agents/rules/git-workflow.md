# Git Workflow & Commit Rules

1. **Commit Convention**:
   - `feat(<scope>): ...`
   - `fix(<scope>): ...`
   - `perf(<scope>): ...`
   - `test(<scope>): ...`
   - `docs(<scope>): ...`
   - `refactor(<scope>): ...`

2. **Branch & Worktree Discipline**:
   - Every multi-step task or parallel agent must run in an isolated git worktree via `using-git-worktrees`.
   - Never commit directly to `main` without automated test passes.

3. **Traceability**:
   - Every feature commit must trace to a ticket or spec section in `docs/ARCHITECTURE.md` or `docs/SpecDoc.md`.
