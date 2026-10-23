# Milestone 0G: supervised Claude workflow trial

Date: 2026-10-23. Cezar branch: `codex/milestone-0f-reliable-agents` at
`2f1d721e` before this report. One real workflow was started; no Cezar source
files were changed.

## Trial boundary

- Disposable repository: `.ai/tmp/milestone-0g-host-20261023/slug-tool` (local
  Git repository, no remote). Isolated home: sibling `cezar-home`.
- Cezar server: `127.0.0.1:47123` only. `maxParallel: 1`; real Claude Code
  selected through `CEZ_CLAUDE_BIN` with the previously verified `claude.ai`
  Pro login. API-key environment variables were removed from the server's
  environment. `CEZ_DRY_RUN=0`.
- `CEZ_AUTOMATIONS=0`, `CEZ_DISPATCH=0`, `CEZ_REMOTE=0`,
  `CEZ_TELEMETRY=0`, `CEZ_SKILLS_AUTO_UPDATE=0`, `CEZ_DESIGN_MODE=0`,
  `CEZ_AUTONAME=0`, `CEZ_AUTOSAVE=0`, and `CEZ_WORKFLOW_WEBHOOKS=0`.
  No automatic merge was requested or performed.
- Workflow: `reliable-npm-task`: Claude may edit files without shell tools;
  Cezar runs `npm test` with a 600-second check timeout. Exit code 1 can
  return to `implement` at most twice. The task used one worktree and one
  variant. The trial lasted about 31 seconds from run creation to completion,
  within the 20-minute limit.

Run `d136b536-749d-4660-90db-8cb69a1bb74e` used branch `cez/d136b536`
and worktree `.ai/cezar/worktrees/d136b536-749d-4660-90db-8cb69a1bb74e`
inside the disposable repository. Its event log is the matching NDJSON file
under the disposable repository's `.ai/cezar/runs/` directory.

## Results

| Requirement | Evidence and result |
| --- | --- |
| Claude implements `slugifyTitle` | **PASS.** Only `src/slug.js` changed: 7 additions, 1 deletion; autosave commit `c3afecd`. The real function handles the fixture's cases. |
| Cezar independently runs `npm test` | **PASS.** `verify` emitted `$ npm test` and `check-output` twice. Claude did not run the command. |
| First failing output returns to Claude | **PASS.** Event 42 recorded exit 1, the deliberate canary assertion, 3 passed and 1 failed, with `quiescent: true` and no truncation. Event 44 routed back to `implement`; Claude's next response explicitly identified the canary and the three passing implementation tests. |
| Claude corrects when needed | **PARTIAL.** Claude received the feedback and assessed it correctly. The failure was solely the one-time canary, so no code correction was needed or made. This fixture did not prove recovery from a real implementation defect. |
| Cezar reruns verification | **PASS.** Event 71 recorded exit 0, 4 passed, 0 failed; event 72 closed the check. A later manual `npm test` also passed 4/4. |
| Correction bound | **PASS for this run.** One correction attempt occurred; `graphState.loops.verify-retry` was 1 and the workflow limit was 2. The run did not exercise the maximum. |
| Review gate follows successful verification | **FAIL.** The run finished as `done`, not `review`, although the worktree had a one-file diff. `reviewGateEnabled` defaults to off; the prepared project had no config file setting `reviewGate`, and the server did not set `CEZ_REVIEW_GATE=1`. Verification did precede completion, but no review gate was reached. |
| Owned subprocess cleanup | **PASS with recorded proof.** Both Claude attempts emitted `process-cleanup: confirmed` (events 37 and 66). Both check outputs recorded `quiescent: true`. After the run, no process command line matched the trial path or run ID apart from the Cezar server; that server was stopped and its loopback listener closed. Unrelated resident Claude Desktop processes were left alone. |
| Usage accounting | **Internally consistent.** Two completed Claude turns recorded 12 input, 1,929 output, 206,666 cache-read, and 67,987 cache-write tokens. Their raw sum is **276,594**. Cezar's legacy weighted `tokensUsed` is **107,592** (59,096 + 48,496). Provider-reported `costUsd` sums to **$0.4588766** (0.1649806 + 0.293896); this is an estimated API-dollar equivalent, not a Claude Pro subscription charge or evidence of API-key billing. |

The first check intentionally created `.trial-first-check-done` in the task
worktree. That untracked marker made the second check pass; the test file was
unchanged. The disposable repository's `main` remained clean, its task branch
had a clean worktree, and no remote was configured. Exactly one run record was
present in this isolated project. No unrelated process was terminated and no
production repository was modified.

## Recommendation

**NO-GO for beginning the autonomous GitHub roadmap scheduler.** The approved
trial proved real Claude execution, independent verification, feedback delivery,
one bounded retry, usage recording, and supervised process cleanup. It did not
meet the required review-gate outcome, and the canary did not require an actual
code correction. Before autonomous scheduling, explicitly enable and verify
the review gate in a disposable run, and use a fixture that requires a genuine
implementation correction. That would require separate permission for another
real workflow. No second workflow was started here.
