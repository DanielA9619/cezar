# Milestone 1B — approved work queue

Branch: `codex/milestone-1b-approved-queue`, based on `5179eb8b`. This milestone launches no provider, starts no background scheduler, and cannot accept or merge changes.

## Working behavior

- `cezar roadmap queue load --input <file>` stores the explicit repository allowlist and local roadmap tasks in `CEZ_HOME/roadmap/queue.json`. The queue reuses `planRoadmap`; it deduplicates issue identity by `owner/repo#number`, ranks across projects, records priority overrides, reasons, timestamps, the last 200 planning decisions, authorizations, and short planning reservations. A cross-process `proper-lockfile` lease serializes read/modify/write operations. A restart reads the same queue.
- `cezar roadmap queue refresh` explicitly reads open issues only for allowlisted repositories with registered project IDs. It follows issue cursors, checks the total and duplicates, confirms the resolved repository identity, and checks previously known missing issue numbers through the forge reference-status API. Failed authentication, rate limits, incomplete pages, uncertain status, and unreadable run state mark that repository unverified while retaining its prior rows. Freshness expires after 15 minutes. The queue does not fetch comments or treat issue text as instructions.
- The cockpit's **Roadmap queue** page (`/roadmap-queue`) displays project, task, priority, dependencies, blockers, proposed agent, authorization, last refresh, status, reason, and next-selection preview. Priority changes persist through a validated workspace API. The API has no authorization-grant, reservation, or execution route.
- Owner authorizations can be stored, edited, or revoked only through the interactive `cezar roadmap queue authorize --input <file>` and `revoke <task-id>` CLI commands. The record includes repository and task identity, scope, agent, workflow, expiration, attempt cap, mandatory review and verification command, with an append-only action history in the record. The cockpit shows these records and their audit history. GitHub labels and local roadmap approval can rank work but cannot create authorization. **All queue responses keep `executionEligible: false`, including rows with active authorization.**
- `requiresReview` now permits the autonomous run mode in an isolated worktree when the effective review gate is enabled. This separates agent continuation from human acceptance: a verified mock autonomous run with changes settles at `review`. Existing autonomous workflows without `requiresReview` retain their prior behavior. Failed checks and uncertain process cleanup still fail rather than reaching review.

## Fictional demonstration

With `CEZ_HOME` pointed to an isolated directory, run:

```powershell
node --import tsx packages/cezar/src/index.ts roadmap queue load --input examples/roadmap-planning.json
node --import tsx packages/cezar/src/index.ts roadmap queue show
```

The demonstrated next selection was `atlas-index` (P1). `beacon-schema` was also ready; `beacon-queue` waited for its dependency; `atlas-release` was blocked by a release freeze; `atlas-old` was completed. Fixture GitHub issues were **stale** until a live refresh. Every row remained in planning mode with execution disabled. Unit tests use fictional registered projects and mocked paginated forge responses; they make no GitHub request.

## Validation

- Focused queue, workspace API, review-gate, foundation planner, and run-start suites: 29 tests passed. The new autonomous-review regression failed against the prior implementation (`failed` instead of `review`) and passed after the fix was restored.
- Monorepo typecheck: passed.
- Production build and package check: passed (`check:pack`: 912 files, 109 web assets).

## Remaining limits before one unattended task

The CLI's interactive-terminal check is an owner-action boundary for recording data, **not** a strong authentication channel against a local process with the owner's OS privileges. Before execution is enabled, bind grants to a protected owner credential and immutable issue identity, recheck authorization/expiration/revocation immediately before launch and every continuation, enforce scope, workflow, attempt and budget limits in the RunManager, and hold a durable execution lease across crash recovery. Verify GitHub status at dispatch time, pin the issue revision, and fail closed on stale source or uncertain cleanup. Add supervised end-to-end execution and restart tests for those paths. GitHub Projects and external roadmap documents are not ingested; local roadmap tasks are loaded explicitly. No autonomous task selection timer or execution wiring exists in this milestone.
