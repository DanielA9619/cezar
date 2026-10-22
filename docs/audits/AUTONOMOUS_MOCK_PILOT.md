# Autonomous Mock Pilot — Milestone 0D

**Date:** 2026-10-22
**Branch:** `baseline/windows-cli-discovery`
**Host:** Windows 10 Pro, version 2009 (22H2)
**Result:** Mock automation pilot passed with the limitations and real-agent prerequisites below.

## Scope and safety

This pilot exercised Cezar's existing schedule automation, quick-task workflow, mock runner, worktree isolation, run persistence, cancellation, restart recovery, and dashboard. It did not test roadmap selection, prioritization, quota management, real code development, real pull requests, or merging. The mock runner produced synthetic changes and metrics; those are not evidence that the fictional application works.

The fixture was a disposable local-only Git repository at `%TEMP%\cezar-m0d-pilot-6f319968b7\fictional-app`, with a fictional “Northstar Notes” roadmap and backlog. It had no remote. Cezar used the isolated home `%TEMP%\cezar-m0d-pilot-6f319968b7\cezar-home` and a temporary Git config for the Windows safe-directory exception. No production repository or credential was used or modified.

The dashboard server listened only at `127.0.0.1:4371`. Its environment included `CEZ_DRY_RUN=1`, `CEZ_HOME=<isolated home>`, `CEZ_NO_BANNER=1`, `CEZ_TELEMETRY=0`, `DO_NOT_TRACK=1`, `CEZ_SKILLS_AUTO_UPDATE=0`, `CEZ_DESIGN_MODE=0`, `CEZ_WORKFLOW_WEBHOOKS=0`, `CEZ_DISPATCH=0`, `CEZ_CODEX_NETWORK=0`, and `CEZ_REMOTE=0`. Empty isolated `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, and `GH_CONFIG_DIR` were used; `GH_TOKEN`, `GITHUB_TOKEN`, `ANTHROPIC_API_KEY`, and `OPENAI_API_KEY` were absent. `CEZ_MOCK_PACE=1` and `CEZ_MOCK_LIMIT_RESET_SECONDS=90` were used for the mock probes. Automation scheduling was left enabled because it is the capability under test. No real Claude or Codex workload was launched, no GitHub repository was created, and no automatic merge was enabled.

## Procedure

1. Create the local fixture repository, seed its fictional roadmap/backlog, and ignore `.ai/cezar/` in its root `.gitignore`.
2. Start the built Cezar CLI in dry-run mode on the loopback-only port above, with isolated home and empty provider/GitHub config directories.
3. Create seven enabled daily automations through Cezar's existing API/UI. They use `quick-task`, the Claude runner selection (resolved to the dry-run mock), task worktrees, and three waves scheduled at 10:55, 11:01, and 11:07 America/Denver. The waves contain 3, 2, and 2 tasks. The initial `maxParallel` was the default 2.
4. Observe the dashboard and run/event APIs while the timers fire. Restart the server between the first and second waves after all first-wave runs reached terminal state.
5. Leave the restarted instance unattended for at least 15 minutes while the remaining schedules run. During that period only read-only status observations were made.
6. Exercise manual cancellation and mock limit-wait/automatic-resume handling, inspect persistent records, receipts, event logs, worktrees, lock-like files, process ownership, and server shutdown.

## Results

| Capability | Observation | Result |
|---|---|---|
| Scheduled execution | All seven schedules fired at their intended 10:55, 11:01, or 11:07 occurrence and produced one receipt and one run ID each. | Pass |
| Multiple tasks and worktree isolation | Seven scheduled runs each had a distinct `cez/<run-id-prefix>` branch/worktree. The separate manual cancellation probe had its own worktree. The fixture root remained clean. | Pass |
| Queue and concurrency | With `maxParallel=2`, the first two 10:55 tasks started within 10 ms. The third started after a slot freed (10:55:28.746). The second wave's two tasks started within 8 ms. Observed scheduled concurrency did not exceed two. | Pass |
| Completion and persistent state | Six scheduled mock tasks reached `done`; their run records, NDJSON event logs, automation state, and receipts survived a server restart. The dashboard “All” view listed all eight final runs, including the failure and cancellation. | Pass |
| Manual cancellation | Run `25ea2edf-962b-4063-b773-2388a2fc2708` was cancelled through the API. Its log recorded `run cancelled` followed by `session.ended`; the run became terminal and its review worktree remained. | Pass |
| Timeout handling | Focused Windows executor lifecycle tests passed 13/13, covering timeout, cancellation, nested descendants, repeated cancellation, and forced supervisor termination. | Pass for executor regression coverage; no real-agent timeout was induced in the pilot. |
| Mock limit recovery | The deliberate `mock:limit` run entered automatic-resume wait, resumed on the configured short reset, and failed on its next mock attempt. A subsequent resume was pending, so it was explicitly cancelled; the durable event log recorded the cancellation and the run had no remaining `autoResumeAt`. | Observed and cleaned up; this is a synthetic limit path, not quota/accounting validation. |
| Server restart and recovery | The tracked server was stopped only after wave 1 was terminal and restarted with the same isolated home. Run count and IDs remained unchanged (3 before and after), no receipt was replayed, and the 11:01 schedules fired once. | Pass |
| Unattended period | From the restart at approximately 10:56:46 until approximately 11:11:46, the instance ran unattended for about 15 minutes and launched the remaining scheduled tasks. | Pass |
| Dashboard and history | The Automations view showed enabled schedules and next times. The task list initially hid automations under the Regular filter; switching to “All” showed the full history. Mock UI output included synthetic cost, diff, and PR-looking values. | Accurate after selecting “All”; default task filter can conceal automation runs. Synthetic PR-looking output is not a real PR. |

The final isolated home contained eight runs: six `done`, one `failed` from the intentional mock limit scenario, and one `cancelled`. There were eight task worktrees plus the fixture root. Each schedule's launch history showed one launched receipt; no duplicate scheduled task appeared after restart. Successful mock runs created synthetic `notes.md` changes and autosave commits, which only demonstrate workflow plumbing.

## Process cleanup and shutdown

The cancellation probe ended its agent session and reached terminal `cancelled` state. The Windows Job Object/supervisor regression suite passed 13/13 focused cases, including cleanup after timeout and cancellation. A final fixture scan found no lock-, lease-, or owner-named files under `.ai/cezar/`. The eight task worktrees remained registered in Git; these are expected review artifacts, not leaked worktrees. Cezar does not automatically remove completed/cancelled task worktrees in this path.

The pilot server was tracked as PID 44956 on `127.0.0.1:4371`; by final inspection it had exited and the listener was gone. No other process was terminated. Windows process inspection returned access denied for some system process details; pre-existing Node/PowerShell processes from the desktop/tool environment were therefore treated as ambiguously owned and left untouched. The executor tests provide the process-tree cleanup evidence; this pilot did not claim ownership of unrelated processes.

## Discovery issues: separate findings

**GitHub CLI:** The isolated pilot deliberately supplied an empty `GH_CONFIG_DIR`, no token, and no remote. Cezar health reported `gh unavailable`, as expected in that isolated setup. The prior Windows baseline and process-cleanup notes report different `gh auth status` results across runs (including an authenticated result and a later invalid-auth result). This pilot does not resolve that host-specific discovery/auth discrepancy. No authentication was changed. GitHub auth is not required for a local, no-remote, no-PR real-agent task.

**Claude CLI:** The pilot selected the Claude backend only under `CEZ_DRY_RUN=1`; health correctly reported the mock runner. It does not establish that a real Claude CLI is discoverable or authenticated. The Windows process-cleanup notes report Claude CLI missing from `PATH`/`where.exe`, while the earlier baseline records a Claude Code version and first-party Pro auth status after a shim adjustment. No real invocation or authentication change was made. A same-user, read-only discovery/auth check is required before a real-agent run.

## Verification

- `npm.cmd exec -- vitest run packages/cezar/src/worktree-lifecycle/executor.test.ts` — **13/13 passed**.
- No source code changed, so typecheck and build were not rerun.
- No broad suite was run; this milestone focused on the Windows executor lifecycle and end-to-end mock automation.

## Assessment for one short real-agent task

**NO-GO on this host until the requirements below are met.** The mock pilot shows that scheduled mock execution, two-slot concurrency, task isolation, persistent history, cancellation, and restart deduplication work in this environment. It does not validate real-agent discovery/auth or real code quality. The prior Windows notes conflict on Claude CLI discovery, and this pilot intentionally avoided real credentials and provider calls.

Exact requirements before a short, manually reviewed real-agent task:

1. On the intended Windows host and same Windows user that will run Cezar, perform read-only checks for the Claude CLI executable/version and its existing first-party authentication status. Resolve the PATH/shim discrepancy without changing authentication. Confirm no API key is being selected unintentionally.
2. Confirm the committed Windows supervisor cleanup fix is present in the checkout used for the task, then rerun the focused executor lifecycle tests on that host.
3. Use a fresh disposable local repository with no remote, an isolated `CEZ_HOME`, loopback-only dashboard, and exactly one short task in a dedicated worktree. Keep auto-merge, remote access, dispatch, telemetry, and unrelated background features off; use the real-agent setting only for this explicitly bounded task.
4. Watch the run through terminal state, inspect the diff and local checks manually, then verify the agent/session process tree ends and the run/worktree history is accurate. Do not treat synthetic mock output as validation.

GitHub CLI authentication is an additional requirement only if a later task needs GitHub operations such as creating a PR; do not change it as part of this local pilot. This assessment makes no claim about autonomous roadmap selection, intelligent prioritization, quota management, or automatic verified merging.
