# Milestone 0F: reliable real-agent execution

Branch: `codex/milestone-0f-reliable-agents`, based on `baseline/windows-cli-discovery`.
Validated host: Windows 10 Pro 22H2 (build 19045), 2026-10-22.

## Process ownership

Claude's multi-turn NDJSON and Codex's app-server JSON-RPC require a writable stdin for the
whole session. The lifecycle executor intentionally supplies closed stdin, redacts text, and
caps output, so routing agents through that executor would break both protocols. Agents instead
use a streaming transport over the existing packaged PowerShell/native Job Object helper.
Only supervisor control frames are encoded; provider stdout and protocol input retain their bytes.
Launch arguments travel over a pipe, avoiding PowerShell command-line length expansion and
exposing no prompt in the helper's command line. The agent receives the same curated environment.

The helper owns a private `KILL_ON_JOB_CLOSE` job. Descendants created normally join that job;
no breakaway flags are enabled. Windows 10's `PROC_THREAD_ATTRIBUTE_JOB_LIST` assigns the
suspended process atomically at creation, removing the prior create/assign crash window;
membership is checked before resuming. See Microsoft's
[process creation attributes](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute).
Normal leader exit also terminates remaining job members.
Cancellation gives Claude input EOF and Codex its existing `turn/interrupt` request plus EOF,
then forces the job after four seconds. Windows does not provide POSIX SIGTERM semantics.
The helper reports completion only after the job's active process count reaches zero; the
runner additionally waits for the helper to close. A broken helper is killed after a bounded
fallback, and missing proof remains uncertain. No process-name matching or recovered-PID killing
is used. The session PID is the helper PID, whose descendants include the agent.

`end()`, messages between turns, resume arguments, and session IDs retain their existing
protocol behavior. The runner wall-clock deadline remains armed until process exit, even when
stdout closes first. Autonomous sessions use the existing 30-minute runner default; ordinary
interactive sessions retain their explicit zero deadline and existing inactivity policy.
Linux/macOS agent spawning stays on its original path.

New run records optionally carry `agentCleanup`:

| State | Meaning and transition |
| --- | --- |
| absent | Historical record or a backend without this supervision capability |
| pending | Ownership checkpoint before execution/while running; successful teardown confirms it |
| confirmed | The owned process tree has exited; continuation and removal may proceed |
| uncertain | Missing cleanup proof; automatic retries, restart recovery, acceptance, and worktree removal are blocked |

An interrupted process retaining `pending` is also blocked after restart. A supervisor crash
closes its job handle, but disappearance of a PID is never used as proof. Retain the worktree
and inspect the host before manually recovering an uncertain task; there is no automatic
"assume clean" action. Historical records are not migrated or claimed to have new proof.

The ownership boundary covers job members. External services, scheduled work, WMI-created
processes, or work delegated to an already-running daemon are outside it. Microsoft's
[Job Objects documentation](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)
describes those membership rules. PowerShell/.NET must be available; helper failure stops the
task, not cockpit boot. Startup adds a small PowerShell compilation cost per process.

## Approved verification

Copy [the example workflow](../examples/workflows/reliable-npm-task.yaml) into the project's
`.ai/cezar/workflows/` directory and select `reliable-npm-task`. Its Claude step permits file
tools without `Bash`. Cezar runs the explicitly selected `npm test` command in the task's
worktree using its own supervised check step. Selecting a check authorizes that command;
it executes repository code with the host user's permissions, not in a hostile-code sandbox.

The workflow allows two corrections after the first attempt. A test exit of 1 returns bounded,
redacted failure output to a fresh agent attempt. Each attempt emits `check-output` with its
exit code, output, cleanup proof, and truncation flag. Failed tests prevent review/acceptance.
Timeout, cancellation, spawn failure, or uncertain cleanup does not buy an agent retry.
Checks default to 30 minutes; optional `timeoutSeconds` accepts 1–86400 on check steps/nodes.
The example uses 600 seconds. Checks still run with a mocked agent under `CEZ_DRY_RUN=1`,
as they did previously; only lifecycle setup/teardown commands use the dry-run no-op.

Continue reruns a linear workflow's declared checks before returning to review. For graph
workflows it repeats previously reached check nodes using persisted node outputs; it does not
rewalk conditional branches, gates or loop bodies. Check output files
retain their existing exclusion from autosave commits, including during continuation. A
cancelled check holds its slot until its own execution finishes; an earlier agent result cannot
serve as cleanup proof. Workflows with no checks keep their existing behavior; `quick-task`
does not acquire a guessed project test command. Check-only workflows remain supported.

An independent review can later be added as an agent step with `runner: codex`, followed by a
final verification command. No Codex workload is enabled by this example. Codex does not honor
Claude's per-tool allowlist; a review prompt alone is not a read-only sandbox.

## Usage accounting

The successful Milestone 0E trial was inspected read-only in its disposable `greeting-app`
repository. Run `c129d8ff-7db4-4e21-9ece-8347478f9d14`, events 98–101, records:

| Metric | Tokens |
| --- | ---: |
| Input | 14 |
| Output | 2,709 |
| Cache read | 189,214 |
| Cache write | 34,483 |
| Raw total | **226,420** |
| Cezar legacy weighted aggregate | **64,748** |

`round(14 + 2709 + 189214 × 0.1 + 34483 × 1.25) = 64748`.
This discrepancy is weighting, not lost events or double aggregation. Claude assistant frames
remain presentation-only for usage; the terminal result is authoritative.
The weights are a legacy approximation, not a complete pricing formula: model output rates,
cache TTLs, and provider pricing can differ. See Anthropic's
[prompt cache accounting](https://platform.claude.com/docs/en/build-with-claude/prompt-caching).

New run/step summaries distinguish `inputTokens`, `outputTokens`, `cacheReadTokens`,
`cacheWriteTokens`, `rawTotalTokens`, and the unchanged `tokensUsed`. Counts fold only once per
completed turn. A missing report stays unknown; a partial cache subtotal is not shown as a
complete total. Codex input already includes cached input, so its reported raw total must not
have cache reads added again. The header exposes the breakdown and labels reported USD as an
estimated API dollar equivalent, never a subscription charge. The trial's provider-reported
`costUsd` was `0.01014464`; this is retained as reported, not independently repriced or treated
as a bill. Codex USD stays unknown when unsupported. Older summaries remain readable without
backfilling or rewriting run history. No quota endpoint or authentication file was accessed.
The unchanged Codex legacy aggregate follows cumulative thread telemetry, which can include
history on a resumed thread; use the new completed-turn raw counters for invocation comparisons.

## Validation and operating recommendation

The focused suites exercise real disposable Windows processes and mock provider protocols:
normal completion, nested cleanup, large streaming input, graceful/forced cancellation,
unrelated-process survival, supervisor termination, runner timeouts, continuation, durable
recovery exclusion, successful/failed checks, bounded correction, cancellation during checks,
usage deduplication/completeness, HTTP contract parity, and the task header.

| Final gate | Result |
| --- | --- |
| Monorepo `npm run typecheck` | PASS |
| Focused Vitest regression set (20 files) | 509 passed, 3 POSIX-only cases skipped |
| Lifecycle coordinator, excluding the POSIX symlink fixture | 35 passed, 2 skipped |
| Directional/raw usage ledger subset | 5 passed |
| Final streaming/argument round-trip check | 3 passed |
| `npm run test:unit` | 40 passed, 2 POSIX launcher cases skipped |
| `npm run build` and `check:pack` | PASS; 899 files, 109 web assets |
| `npm run test:package` | 25 passed, including installed mock CLI cleanup proof |

The new raw/cache persistence regression was also run against a temporary copy of the baseline
RunManager and failed on missing raw/cache counters; it passes with the implementation. The
working implementation was never stashed or replaced during that check. Windows fixture
repairs use native directory creation, isolate `USERPROFILE` as well as `HOME`, wait for cold
PowerShell startup, and retry transient file locks. The tarball fixture launches npm through
Node rather than treating `npm.cmd` as an executable; it asserts that both the streaming
transport and native helper ship, and that the installed mock CLI records confirmed cleanup.

The broad Windows diagnostic is **not green**: 10,591 passed, 444 failed, 47 skipped and one
unhandled error across 661 files. It ran during implementation and includes timing/fixture
failures subsequently repaired and rechecked above. The earlier baseline also had hundreds of
failures; this is not a matched baseline comparison, and the remaining failures have not all
been triaged as harmless. It does not certify the entire upstream test suite on Windows.
The initial sandboxed pack check could not write npm's existing cache; build and package gates
were then rerun successfully with cache access. Validation logs remain local, outside the commit.

**GO for the next explicitly approved, timeboxed, supervised real-agent development trial on
this Windows 10 host**, in a disposable development repository using an explicit verification
workflow. **NO-GO for unattended or production work**, a Windows-wide stability claim, or
Windows 11 certification. Real-provider cancellation, crash recovery and resume still need an
approved canary; this milestone deliberately spent no provider tokens. A failed continuation's
verification stops for the operator; automatic bounded corrections belong to the workflow's
normal `onFail` path. Graph continuations do not reconstruct an entire conditional workflow.

No paid provider task, production repository, deployment, remote-access change, credential
change, merge, or subscription-quota request is part of this milestone.
