## Milestone 0B continuation — Codex Desktop session

**Date:** 2026-10-22  
**Branch:** `baseline/windows-cli-discovery` at `72c0f8a4` before this session's commit  
**Recommendation:** **NO-GO** for the disposable autonomous-repository test.

This session ran on Windows 10 Pro 22H2, build **19045.6466** (confirmed from the Windows version registry and `cmd /c ver`). It is not the Windows 11 host described for the next milestone, so it cannot certify that machine. Git initially rejected the checkout as unsafe because of the owner mismatch. Repository inspection used a command-scoped `safe.directory` override; no Git ownership or global safety setting changed.

### Current environment

| Check | Result |
| --- | --- |
| Cezar Windows shim regression | **PASS** — `npm.cmd test -- packages/cezar/src/core/windows-shim.test.ts`: 11/11. The PATH lookup case maps an npm `.cmd` shim directly to its Node script without a shell. |
| Cezar Codex resolution | **PASS** — `spawnableCommand("codex", ["--version"])` resolved the npm CLI target `C:\Users\Daniel\AppData\Roaming\npm\node_modules\@openai\codex\bin\codex.js`; target exists and reports `codex-cli 0.163.0`. Its `login status` reports ChatGPT sign-in. |
| Claude discovery | **FAIL in this session** — `resolveClaudeBin()` returned bare `claude`, which is not on PATH; no `claude.cmd` or `claude.exe` was found at the checked install locations. No Claude task was launched. This differs from the earlier session's Claude 2.1.304 result. |
| GitHub CLI authentication | **FAIL in this session** — `gh auth status` reports the saved token in `C:\Users\Daniel\AppData\Roaming\GitHub CLI\hosts.yml` is no longer valid. Credentials were not changed. |
| `npm.cmd run typecheck` | **PASS** — contract, client, server, and web. |
| `npm.cmd run build` | **PASS** — server, web, and `check:pack` (895 packaged files, 109 web assets). |
| `npm.cmd run test:package` | **FAIL** — 24/25 pass. `package-cli.test.ts` passes `npm.cmd` to Node `execFile`, which fails with Windows `EINVAL`; this is a Windows test-launcher incompatibility. |
| `npm.cmd run test:unit` | **FAIL** — 39 passed, 2 failed, 1 skipped. `skills-remote.test.ts` spawns POSIX `mkdir -p`; `test-env-launcher.test.ts` invokes `/bin/sh`. The `setsid` case is skipped because it is unavailable. |
| Disposable dry-run CLI workflow | **PASS** — built CLI ran `mock:done` against a temporary Git repo with `CEZ_DRY_RUN=1` and isolated `CEZ_HOME`; one run persisted with status `done`. Output included the built-in mock's synthetic transcript and PR URL; no provider or GitHub write occurred. Fixture: `%TEMP%\cezar-m0b-mock-45cf2077296144eb8e0f5e4e895daffe`. |
| Dashboard | Prior loopback Chrome validation remains documented above. It was not repeated in this Desktop session. |

Upstream comparison: the locally available `upstream/main` snapshot is `08dc8428`; its `windows-shim.ts` still has the pre-change implementation. The PATH lookup remains an additive Windows-only change. No upstream fetch was performed.

### Full-suite reproduction and failure groups

`npm.cmd test` completed in 393 seconds: **514 failed, 10,502 passed, 44 skipped** across 657 files (95 files failed), plus one unhandled cleanup error. This is 37 more failing tests than the prior 477-failure run. It does not implicate the Windows shim change: the focused shim suite passed, and the failures cluster around host/test assumptions:

- POSIX-only fixtures call `mkdir`, `/bin/sh`, `setsid`, and Unix process-group signaling. The native Windows host does not provide the expected POSIX behavior.
- Bare `bash` resolved to `C:\Windows\System32\bash.exe` (the WSL launcher). Test logs included WSL path-translation failures and Git Bash/Windows path spelling mismatches.
- Permission-mode tests expect POSIX `0600`/`0700`; Windows-reported file modes do not match those assertions.
- Git fixture tests hit Windows filename-length limits (`Filename too long`) and path/fixture assumptions. Numerous workflow tests hit 5-second timeouts, and run-store fixtures logged `ENOENT` while cleanup raced pending writes.
- One unhandled test cleanup attempted to remove a temporary path that was no longer a Git worktree. It was inside a disposable test fixture, not the Cezar checkout.
- The test run exercised local mock runners and temporary Git repositories; it did not run a real Claude/Codex task or write to GitHub.

The full suite does not prove that all 514 failures are harmless platform skips. In particular, the lifecycle failures below expose a real cleanup risk and remain a release blocker for unattended Windows work.

### Process cleanup drill

The default full-suite run selected the WSL launcher for Cezar's lifecycle supervisor. After the suite exited, seven processes whose command lines matched Cezar's private supervisor wrapper and their WSL children were still present. They were identified by exact command line, terminated as disposable test processes, and verified gone. An unrelated pre-existing Claude shell was left untouched.

The focused lifecycle tests with Git Bash explicitly first in PATH reported 5 passed, 3 failed, and 3 skipped. Normal completion returned `succeeded` and `quiescent: true`; the cwd assertion failed because Git Bash reports `/tmp/...` while the test expects a Windows path. Timeout and abort returned `quiescent: false`.

A separate one-second timeout through `executeLifecycleCommand()` confirmed the consequence: it returned `state: interrupted`, `reason: Command exceeded its wall-clock timeout`, and `quiescent: false`. The supervisor exited, but its `sleep.exe 30` child remained alive. The child was found by PID/start time, terminated directly with `taskkill.exe`, and verified gone. This proves the current Windows process-tree cleanup can leave an orphan even when Git Bash is selected.

Normal task completion is partially verified by the focused executor run. User cancellation and timeout are **not verified safe**. Agent-subprocess termination, unexpected server shutdown, recovery after an active interruption, and automatic prevention of orphans are **not certified**. Recovery must remain operator-reviewed when Windows reports process identity as unknown; this session did not run a full crash/restart drill.

### Milestone decision

**NO-GO** for the disposable autonomous-repository test. The confirmed orphan on timeout is sufficient to hold the gate. The host is also Windows 10 rather than the intended Windows 11, Claude is not currently discoverable, and `gh` authentication is invalid. Codex's installed CLI is discoverable and signed in, but that does not clear the process-safety gate.

Next validation should happen on the intended Windows 11 machine with Git Bash deliberately selected, then resolve and re-run the cancellation/timeout process-tree drill until no child remains. Repeat the dashboard and mock task checks there. Preserve the current auth state; only reconsider a real provider task after the owner has explicitly approved it. No R515 deployment, permanent service, remote exposure, production repository change, or merge was performed.

---
# Windows baseline validation

**Date:** 2026-10-22  
**Repository revision:** `72c0f8a4` (`docs: add Cezar architecture audit`)  
**Validation branch:** `baseline/windows-cli-discovery`  
**Scope:** local setup, static validation, mock task lifecycle, Windows CLI discovery and process handling.

## Executive result

Cezar installs, typechecks, builds, serves its cockpit locally, and persists mock runs and isolated worktrees across a server restart. The normal Vitest suite and the Windows lifecycle-executor checks do not pass on this host. No real agent task, GitHub write, remote listener, auto-merge, or permanent service was started.

The machine information exposed to this run reports **Microsoft Windows 10 Pro, build 19045**, despite the assignment describing Windows 11. These results therefore do not certify Windows 11 behavior. The host has Node 24.18.0, npm.cmd 11.5.2, and Git 2.37.0.

## Pass/fail table

| Area | Result | Actual result |
| --- | --- | --- |
| Prerequisites and install | **PASS with environment workarounds** | `npm.cmd install` added 661 packages and audited 672. PowerShell's `npm` shim hit an access-denied error; `npm.cmd` worked. |
| Claude/Codex installation and sign-in | **PASS** | Claude Code 2.1.304 reports `claude.ai` first-party Pro auth. Codex CLI 0.163.0 reports ChatGPT sign-in. No task was sent to either provider. |
| Cezar backend discovery | **PASS after fix** | Cezar initially missed both npm-installed Windows CLIs. On `baseline/windows-cli-discovery`, Cezar's read-only discovery found Claude 2.1.304 and Codex 0.163.0 with no `CEZ_*_BIN` overrides. |
| GitHub CLI | **PASS on follow-up verification** | The initial check reported an invalid saved token. A later check in this execution environment succeeded with the same `gh.exe` path and regular-user config; `gh api user` returned `DanielA9619`. No credential was changed. |
| API-key billing isolation | **PASS for this run; workload untested** | `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` were absent from the process environment. Auth status identifies Claude first-party and Codex ChatGPT sign-in. No live workload was run, so billing behavior was not exercised. |
| Full Vitest suite (`npm test`) | **FAIL** | 10,538 passed, 477 failed, 44 skipped across 657 files; 94 files failed. Failures span Windows file-mode/signal assumptions, missing POSIX commands, sandbox file access, real `gh` authentication reached by some fixtures, and 5-second timeouts. |
| Node unit suite (`npm run test:unit`) | **FAIL** | 38 passed, 3 failed, 1 skipped. Failures: `skills-remote.test.ts` invokes missing `mkdir`; a dependent team-skills assertion then fails; `test-env-launcher.test.ts` expects `/bin/sh`. `setsid` case skipped because it is unavailable on Windows. |
| Focused Windows shim regression | **PASS** | `windows-shim.test.ts`: 11 passed, including bare PATH lookup of an npm `.cmd` shim without invoking `cmd.exe`. |
| Typecheck | **PASS** | Contract, API client, server, and web TypeScript checks all passed after the fix. |
| Build and package gate | **PASS, run in stages** | Server build, web build, and `check:pack` passed. The first root `npm run build` stopped only at `check:pack` because the sandbox denied npm-cache writes; the package gate passed when rerun with normal filesystem access. |
| Cockpit/dashboard | **PASS** | Loaded in Chrome from `http://127.0.0.1:4331` on loopback. The SPA rendered the project task list and task detail. |
| Mock task, queue, worktrees, persistence | **PASS** | One UI task and three concurrent API-created mock tasks completed. Two started together; the third started after a slot freed. Four distinct task worktrees and four run records remained after restart; Cezar logged that it recovered all four. |
| Windows lifecycle process cleanup | **FAIL / unresolved** | The focused executor suite failed 7/11 tests with the default PATH. Prepending Git Bash changed the result to 5/11 passed, 6 failed. Cancellation/timeout quiescence and the taskkill fixture remain unproven on this host. |
| Crash/reboot recovery | **PARTIAL** | Graceful server restart recovered the four completed mock runs. No active real child process was killed, no crash was injected, and no reboot/service recovery was tested. |

## Toolchain and authentication checks

Commands and observations:

| Command | Result |
| --- | --- |
| `node --version` | `v24.18.0` |
| `npm.cmd --version` | `11.5.2` |
| `git --version` | `2.37.0.windows.1` |
| `claude.cmd --version` | `2.1.304 (Claude Code)` |
| `claude.cmd auth status` | Logged in with Claude first-party `claude.ai` Pro auth. |
| `codex.cmd --version` | `codex-cli 0.163.0` |
| `codex.cmd login status` | Logged in using ChatGPT. |
| `gh --version` | `2.13.0` |
| `gh auth status` | Initial check failed with an invalid-token result; follow-up check succeeded for `DanielA9619` using `C:\Users\Daniel\AppData\Roaming\GitHub CLI\hosts.yml`. |
| `gh api user --jq .login` | Follow-up check returned `DanielA9619`. |
| Cezar `detectEnvironment()` | Initial validation found Claude and Codex after the fix, Git available, and `gh` unavailable while the first auth check failed. The later successful GitHub auth check was not followed by another `detectEnvironment()` call. |

The authentication status and user lookup commands were read-only. On follow-up, `gh` resolved to `C:\Program Files\GitHub CLI\gh.exe`; no `GH_TOKEN` or `GITHUB_TOKEN` environment variable was present, and `GH_CONFIG_DIR` was unset. The regular-user `hosts.yml` credential worked. The earlier invalid-token result could not be reproduced, and no credential was overwritten or reset. Cezar's actual task run used `CEZ_DRY_RUN=1`, which routes the task through its bundled mock. The mock displays synthetic token/cost values and a fake PR URL; those are fixture output, not provider usage or a GitHub write.

## Installation and validation commands

The repository's local-development instructions in `docs/reference.md` specify `npm install`, followed by build, typecheck, and tests. On this PowerShell host I used `npm.cmd` because the `npm.ps1` entrypoint tried to inspect a protected npm user path and reported access denied.

Commands run:

```text
npm.cmd install
npm test
npm.cmd run test:unit
npm.cmd run typecheck
npm.cmd run build:server
npm.cmd run build:web
npm.cmd run check:pack
npm.cmd exec -- vitest run packages/cezar/src/core/windows-shim.test.ts
npm.cmd exec -- vitest run packages/cezar/src/worktree-lifecycle/executor.test.ts
```

`npm.cmd install` reported **13 audit findings**: 1 low, 7 moderate, and 5 high. No `npm audit fix` was run. npm normalized optional dependency metadata in `package-lock.json`; that generated lockfile-only diff was reverted, and the lockfile is unchanged on the validation branch.

The root `npm run build` was also attempted. Server and web compilation completed, then `check:pack` failed because npm could not create a temporary directory in the user npm cache under the restricted sandbox. Rerunning `npm.cmd run check:pack` with normal user filesystem access passed: **895 files packaged, including all 109 web assets**. The server build, web build, and package gate were all rerun or completed successfully after the source fix.

## Mock task, queue, worktree, and persistence drill

A disposable Git repository was created under `%TEMP%\cezar-win-baseline-20261022-a`, with a separate `CEZ_HOME` under `%TEMP%`. The local-only server used:

```text
CEZ_DRY_RUN=1
CEZ_NO_BANNER=1
CEZ_TELEMETRY=0
DO_NOT_TRACK=1
CEZ_SKILLS_AUTO_UPDATE=0
CEZ_AUTOMATIONS=0
```

The server bound to `127.0.0.1:4331`. The cockpit loaded in Chrome. One task was created in the UI, then three were submitted concurrently to the project-scoped `POST /api/v1/p/<projectId>/runs` endpoint with the built-in `quick-task` workflow, Claude runner, and worktrees enabled. The server returned HTTP 201 for all three. The workspace cap was two: the first two runs shared a start time; the third began about 2.5 seconds later. All four mock runs reached `done`.

`git worktree list --porcelain` showed the checkout plus four task worktrees, each on its own `cez/<id>` branch. After stopping and restarting Cezar against the same fixture and `CEZ_HOME`, startup reported `recovered 4 run(s) from the previous session`. The four records and their transcripts reloaded in the cockpit. This verifies persisted completed-run recovery; it does not establish recovery of a live provider session or exactly-once execution after a crash.

The fixture remains in `%TEMP%` for inspection. It is separate from the Cezar checkout and any production repository.

## Windows-specific findings

### Small fix implemented

PowerShell found Claude and Codex through their npm `.cmd` shims, but Cezar's no-shell `execFile` probes received bare command names and reported both as missing. The existing Windows shim parser already knows how to translate supported npm shims into direct Node/native invocations without invoking `cmd.exe`.

On `baseline/windows-cli-discovery`, `spawnableCommand()` now resolves bare Windows commands from PATH and accepts only native executables or shims whose targets pass that existing parser. A regression test covers `codex` resolving to an npm `.cmd` shim. The focused test, typecheck, server build, and web build pass; Cezar's read-only discovery then found both installed CLIs. No global PATH or user configuration was changed.

### Remaining Windows risks

- `Get-CimInstance Win32_OperatingSystem` reports Windows 10 Pro build 19045, not Windows 11. Repeat this milestone on the intended Windows 11 installation.
- `where.exe bash` resolves `C:\Windows\System32\bash.exe` first, which is the WSL launcher. Git Bash exists at `C:\Program Files\Git\bin\bash.exe` but is not on PATH. With the default PATH, lifecycle executor tests timed out and left some temporary directories locked. Prepending Git Bash reduced timeouts but exposed path translation and process-tree quiescence failures.
- `taskkill.exe` is present. Cezar's Windows executor uses `taskkill /PID <owned-pid> /T /F`, and on uncertain shutdown keeps the worktree protected. The focused suite still failed cancellation/timeout quiescence cases, so unattended process cleanup is **not certified** by this run.
- Several tests assume Unix permission bits (`0600`/`0700`), POSIX signals, `mkdir`, `/bin/sh`, or `setsid`. They need Windows-aware assertions or platform skips before the full suite can serve as a Windows pass/fail gate.
- The checkout itself is marked unsafe by Git because its ownership differs from the process identity. Commands were run with per-command `git -c safe.directory=F:/Github/cezar`; no global Git safety setting was changed.
- GitHub CLI authentication now succeeds in this execution environment. If a future command reports otherwise, compare its identity, `gh.exe` resolution, and config path before considering any credential action.
- The restart drill only covered completed mock records. Reboot supervision, stale child cleanup, and live Claude/Codex session continuation remain unverified. The repository documents Linux systemd and macOS launchd installers, not a Windows service installer; no service was installed.

## Installation notes for this computer

1. Keep Node 20+ and Git available. This host has Node 24.18.0 and Git 2.37.0.
2. From PowerShell, use `npm.cmd install`, then `npm.cmd run build` and `npm.cmd run typecheck`. `npm.cmd` avoids the blocked PowerShell npm shim on this account.
3. Use `CEZ_DRY_RUN=1` for cockpit and task-flow checks. Keep Cezar bound to loopback; no remote access is needed for this setup.
4. Before unattended work, decide whether Git Bash or WSL is the supported command shell and validate timeout/cancellation against that shell. Do not rely on this run as proof of child-process cleanup.
5. Re-authenticate `gh` only when the user is ready to exercise GitHub features in a dedicated sandbox repository.

## Recommended next step

Repeat the lifecycle-executor drill on the actual Windows 11 host with Git Bash selected deliberately, then fix or platform-scope the failing cleanup tests before running a single low-risk task in a new local/private test repository. Keep it non-autonomous and mock-only until the Windows process-cleanup result is green; only then request approval for one real subscription-authenticated task. Do not add the R515, remote access, or merging to that next step.
