# Milestone 0G closeout and Milestone 1 planning foundation

Branch: `codex/milestone-1-roadmap-planning`. This change runs no real Claude or
Codex workload and changes no repository outside Cezar.

## Review gate closeout

The 0G run ended as `done` because `CEZ_REVIEW_GATE` was unset and the project
had no `reviewGate` override. The effective gate is intentionally off by
default; a project setting wins over the environment variable.

Workflows that promise human review can now declare `requiresReview: true`.
The example `reliable-npm-task` does so. `POST /runs` refuses such a workflow
with 409 before creating a run when review is disabled, autonomous mode is on,
or the task would be in place or read only. The run manager repeats the check
before its first agent spawn and on Continue, so CLI and recovered/queued paths
cannot bypass the route. At settlement, a required-review run without an
available diff and enabled gate fails instead of reporting `done`. A successful
verified run with a diff parks at `review`; Finish/acceptance and merge remain
human actions. This does not switch the global review gate on for other
workflows.

The deterministic mock test starts with an actual broken `slugifyTitle` body.
Cezar's own `npm test` reports `EXPECTED_SLUG_FAILURE` at exit 1; the retry
prompt contains that output; the simulated agent writes a corrected body; the
second test passes and the task reaches `review`. A stubborn mock leaves the
defect in place for the initial attempt and both allowed corrections; all
three checks fail and the task remains `failed`, with Finish refused. Neither
case uses a failure canary or launches a provider.

## Planning-only roadmap preview

`cezar roadmap preview --input examples/roadmap-planning.json` reads an explicit
repository allowlist, local roadmap tasks, and fixture GitHub issue responses.
It ranks approved candidates by priority, explains each decision, and excludes
duplicates, completed work, already-running work, disallowed repositories, and
tasks with unmet dependencies or blockers. Rows include a proposed backend and
the existing `reliable-npm-task` workflow for display. Every row persists
`executionEligible: false` to `CEZ_HOME/roadmap/preview.json`. No planning
input field can change that value. The command has no RunManager call, timer,
server route, or provider spawn.

`--github` is an explicit read-only refresh. Each allowed `owner/repo` must
name a registered Cezar `projectId`; the command uses the existing forge
driver and checks that its resolved repository matches the allowlist. It reads
saved Cezar run records to exclude issue-linked running and completed tasks.
The default preview makes no GitHub request. The repository fixture is
fictional, so use it without `--github`:

```powershell
$env:CEZ_HOME='F:\Github\cezar\.ai\tmp\milestone-1-roadmap-demo-home'
node --import tsx packages/cezar/src/index.ts roadmap preview --input examples/roadmap-planning.json
```

The demonstration ranked `atlas-index` and `beacon-schema` (P1), then
`fictional/beacon#7` (P3), as ready. It explained the release freeze, pending
approval, unmet dependency, completed task, disallowed repository, and already
running issue. All nine rows had execution eligibility false.

## Validation and remaining limits

- Final targeted API, contract, verification, review-gate, mock correction,
  and planner tests: 31 passed across six files.
- Monorepo typecheck: passed.
- Production build and package check: passed (`check:pack` found 905 files,
  including 109 web assets).

This is a CLI planning preview, not a background scheduler or cockpit queue.
Roadmap tasks currently come from local JSON; GitHub Projects/roadmap documents
are not ingested. The optional live GitHub reader is bounded by the existing
forge page and does not prove all open or closed issues were seen. Ranking
does not reserve work across multiple planner processes; persistence keeps the
latest preview, not an append-only decision history. The workflow editor does
not yet expose `requiresReview`, so required-review workflows are authored in
YAML. No authenticated,
audited execution-authorization channel exists, so no selected task can be
launched unattended. Before that changes, add owner-granted per-task execution
authorization, freshness and deduplication across concurrent schedulers,
resource/budget policy, a manual review/merge policy, and supervised recovery
tests. Keep issue content and roadmap approval separate from that authority.
