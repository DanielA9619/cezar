# Windows process cleanup validation

**Date:** 2026-10-22
**Branch:** `baseline/windows-cli-discovery`
**Host:** Windows 10 Pro 22H2, build 19045.6466 (not the intended Windows 11 host)
**Scope:** lifecycle command supervision, process-tree termination, recovery safety, and the prior Claude CLI discovery discrepancy.

## Result

The Windows lifecycle executor now uses an in-box Windows PowerShell supervisor with a native Windows Job Object. The supervisor creates Git Bash suspended, assigns it to a job configured with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, and only then resumes it after Cezar has durably saved the process identity. Job membership propagates to descendants by default. When Bash exits, the supervisor terminates any remaining members and reports quiescence only after the job's active-process count reaches zero.

Cancellation and timeout send an idempotent `STOP` control message. The helper terminates the job, waits for the process count to reach zero, and emits a run-specific completion marker. If the helper crashes or is forcibly terminated, closing its last Job Object handle kills the job. That crash path has no trustworthy completion marker, so Cezar records `quiescent: false`; Windows recovery reports the persisted PID as `unknown`, and the coordinator withholds retry and worktree removal actions.

This uses no new npm dependency and adds no hosted service or recurring cost. The Windows process-control helper is packaged as source and uses Windows PowerShell plus .NET Framework P/Invoke. Git Bash remains the command interpreter for existing POSIX lifecycle scripts. Automatic Windows selection searches the standard Git for Windows locations and Git PATH entries; it deliberately does not select `C:\Windows\System32\bash.exe` (the WSL launcher) as though it were Git Bash. Linux/macOS retain their existing detached process-group flow.

## Why the previous path was unsafe

The Windows executor launched Bash directly and called `taskkill /PID <wrapper-pid> /T /F` on stop. A successful taskkill invocation was not sufficient evidence that the process tree had exited. The prior baseline audit recorded a one-second timeout returning `quiescent: false` while a `sleep.exe` descendant remained alive after the supervisor exited. A later local probe in this session also reproduced an interrupted timeout result with `quiescent: false`. Its PID came from Git Bash's POSIX namespace, so it was not used to signal or identify a Windows process.

Windows Job Objects provide the needed ownership boundary. Microsoft documents that child processes join a job by default, that a suspended process can be assigned before it begins running, and that closing the last handle on a job configured with `KILL_ON_JOB_CLOSE` terminates its members. The helper sets no breakaway flags. See [Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects) and [AssignProcessToJobObject](https://learn.microsoft.com/en-us/windows/win32/api/jobapi2/nf-jobapi2-assignprocesstojobobject).

## Process state and worktree safety

- A normal helper completion marker is emitted only after the job reports zero active processes.
- A command that cannot be created reports a nonzero result with confirmed quiescence; a failed or missing helper marker is a failure with uncertain quiescence.
- A timed-out or cancelled operation is never reported as successful.
- Windows recovery does not signal a persisted PID. A PID with `quiescent: false`, a missing quiescence value, a foreign hostname, or otherwise uncertain ownership remains `unknown`.
- The coordinator blocks retry, force-delete, and related cleanup actions unless process quiescence is positively established. The new regression covers an interrupted execution with an uncertain process identity and verifies that its worktree remains present.
- A forced helper termination is covered by a disposable Windows test. The test positively identifies the helper from that execution's durable `onStart` callback, terminates only that helper, verifies that uniquely named child and grandchild test executables disappear, and expects Cezar to retain uncertain process state.
- Repeated `AbortController.abort()` calls exercise the idempotent stop path.

## Reproducible checks

Run from the repository root on Windows with Git for Windows installed:

```powershell
npm.cmd exec -- vitest run packages/cezar/src/worktree-lifecycle/executor.test.ts
npm.cmd exec -- vitest run packages/cezar/src/worktree-lifecycle/coordinator.test.ts --testTimeout=20000 -t '^(?!.*boot reconcile leaves a symlinked .ai alone when no lifecycle state exists)'
npm.cmd run typecheck
npm.cmd run build
```

Results on this Windows 10 host:

| Check | Result |
| --- | --- |
| Lifecycle executor, including Windows Job Object integration | **PASS — 13/13** |
| Coordinator lifecycle tests, excluding the POSIX `ln -s` case | **PASS — 33 passed, 2 skipped** |
| Monorepo typecheck | **PASS** |
| Production build and package check | **PASS — 896 files, including the helper; 109 web assets** |
| Full test suite | **Not rerun** |

The unfiltered coordinator file has a Windows-only `ln -s` fixture that fails with `spawnSync ln ENOENT`; it is an existing Unix-specific case and remains unchanged. One multi-command retry case exceeded its default five-second test timeout on Windows because every lifecycle invocation starts the PowerShell supervisor; its timeout is now 20 seconds on Windows only. The earlier baseline full-suite reports document additional POSIX command, permission-mode, signal, path, and timing assumptions. This change does not broadly alter those unrelated tests.

The helper integration tests use copied, uniquely named `sleep.exe` files inside disposable temp directories. They cover normal completion with nested background descendants, user cancellation, wall-clock timeout, repeated cancellation, and forced supervisor termination. Windows PID reuse/identity uncertainty is treated conservatively: the probe does not signal or infer liveness from a persisted PID, and the test uses the current test process PID as a stale-identity stand-in and verifies that it remains alive.

## Host and CLI discovery

The live host is **Windows 10 Pro 22H2, build 19045.6466**, confirmed by `cmd /c ver` and the .NET OS version. It is not Windows 11, so this work cannot certify the intended Windows 11 machine.

Read-only CLI discovery in this session found `codex.exe` but found no `claude`, `claude.cmd`, or `claude.exe` through `where.exe`/PowerShell command discovery. No `claude` task was started. The earlier baseline validation recorded Claude Code 2.1.304, while the following session recorded Claude as unavailable. This session did not inspect or modify credentials. The current code's spawn-safe Claude candidates intentionally omit `.cmd` shims; if Claude is installed only as an npm shim outside PATH, that is a separate discovery-path limitation. No authentication reset or change was made.

## Decision

**GO for one mock autonomous test in a disposable repository on this Windows 10 host**, with `CEZ_DRY_RUN=1`, an isolated `CEZ_HOME`, and no real Claude/Codex workload. The process ownership tests now pass, and uncertain helper termination still blocks retries and worktree deletion. This GO applies only to a mock test; it does not certify Windows 11, real provider execution, long unattended runs, or a full Windows test-suite pass. Keep real-agent execution **NO-GO** until the same process cleanup and CLI discovery checks are repeated on the intended Windows 11 host.

No credentials were modified, no production repository was used, no service was installed, and no branch was merged to `main`.
