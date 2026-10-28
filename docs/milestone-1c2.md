# Milestone 1C.2 — guarded real-agent execution

Branch: `codex/milestone-1c2-guarded-real-execution`, based on `6b0b0494`.

This milestone prepares one supervised Claude Pro task. No real model prompt has
been sent, no real task grant has been created, and no real queue dispatch has run.
The previous Hello enrollment and mock demonstration are retained, not repeated.

## Execution policy

The existing queue bridge now has two explicit paths. Existing tasks and grants
remain mock-only. `queue-claude-pro-verify` requires all of:

- `CEZ_QUEUE_REAL=1`, `CEZ_DRY_RUN` not `1`, Windows, and an explicit task ID on
  `cezar roadmap queue dispatch <task-id>`.
- A fresh Windows Hello assertion whose grant includes `executionMode: claude-pro`,
  `agent: claude`, the real workflow revision, canonical repository root, immutable
  local task revision, `scope: sum.mjs`, `cezar:sum-verify`, expiry, attempt cap, and
  mandatory human review. A mock grant cannot satisfy these checks.
- A repository inside the isolated home's `roadmap/disposable`, with the exact
  controlled fixture files, no remote, no executable Git hooks or custom hooks
  path, and only the review gate in its project configuration. Protected content
  is checked in the source and worktree before steps and before review.
- Existing first-party `claude.ai` authentication with `subscriptionType: pro`.
  The read-only CLI preflight uses the same reduced environment as execution.
  Unknown authentication, API key/helper/cloud auth, or missing safety flags deny
  execution. No credential is copied or changed and no login fallback is attempted.

The queue's cross-process lock admits one live claim across different tasks.
`claimed`, `running`, and `uncertain` claims occupy that slot. Claims for completed
tasks remain durable, preventing repeat execution after restarts or reapproval.
Run records persist provider-start counts before process creation: no more than
the signed attempt cap, even if session-recovery code tries an extra launch.

The runner forces Sonnet, restricted mode, safe mode, `dontAsk`, an empty setting
source list, no MCP servers, no extra directories, and only Read/Edit/Write with
write permissions for `sum.mjs`. Bash, PowerShell, agent dispatch and network tools
are unavailable. Ambient provider keys, cloud toggles, `NODE_OPTIONS`, profile
overrides, and environment passthrough are removed. Auxiliary task naming and
usage-limit auto-resume are disabled for queue runs in code. Provider restrictions
use the installed CLI's supported flags; see the [CLI reference](https://code.claude.com/docs/en/cli-reference).

Each provider process uses the existing Windows Job Object supervisor. Missing
quiescence proof persists `agentCleanup: uncertain`, retains the claim and worktree,
and blocks verification, retries and worktree mutations. Queue runs are explicitly
failed on restart instead of requeued, even if their last cleanup was confirmed.
The fixed external verifier must pass before review. Auto-landing is disabled.

## GitHub authentication finding

Read-only identity checks showed:

| Context | Windows identity | GitHub result |
| --- | --- | --- |
| Codex sandbox commands | `DESKTOP-KCR5JQ3\CodexSandboxOffline` | `gh auth status` fails |
| Approved host commands | `DESKTOP-KCR5JQ3\Daniel` | Existing `DanielA9619` login succeeds |
| Observed Cezar Node process (PID 44956 during inspection) | `DESKTOP-KCR5JQ3\CodexSandboxOffline` | Runs in the failing identity context |

Both command contexts resolved `C:\Program Files\GitHub CLI\gh.exe` and
`C:\Program Files\Git\cmd\git.exe`. Both inherited Daniel's `USERPROFILE`,
`APPDATA`, and the reported GitHub configuration path
`C:\Users\Daniel\AppData\Roaming\GitHub CLI\hosts.yml`. Neither had `GH_TOKEN`,
`GITHUB_TOKEN`, or `GH_CONFIG_DIR` set. Identical path strings do not confer
Daniel's Windows access rights or authenticated network context. The sandbox's
"token no longer valid" message did not establish that Daniel's token was invalid;
the host read succeeded. No credential contents were read, copied or replaced.
The evidence identifies an execution-context boundary, not a need to reauthenticate.

The actual `readGithubIssue` implementation read explicitly allowlisted
`open-mercato/cezar#1691` twice through a disposable local probe repository. At
`2026-10-26T18:41:20.987Z` both snapshots matched and freshness passed:
repository ID `1243317327`, issue ID `6038064959`, issue revision
`2026-10-26T11:19:03Z`, digest
`e426a62d572f00826f35fb59ccedc95acc5fcd662d5d8e177153bd13a442f38b`.
The issue was open but lacked `roadmap-approved`; it was never execution-eligible.
No GitHub object was written during verification. **Real GitHub-linked dispatch remains disabled** even
with this successful live reader check. The local fixture needs no GitHub access.

## Claude discovery finding

The existing npm launcher is
`C:\Users\Daniel\AppData\Roaming\npm\claude.cmd`. It delegates to
`node_modules\@anthropic-ai\claude-code\bin\claude.exe`, not a JavaScript entrypoint.
Cezar previously checked native installer locations and a binary beside Node, but
missed this installed native executable. Discovery now checks that known location
and launches the executable directly, never through the `.cmd` shell shim.

Read-only `--version`, `--help`, and the exact guarded authentication preflight
succeeded as Daniel: Claude Code `2.1.304`, `authMethod: claude.ai`,
`apiProvider: firstParty`, `subscriptionType: pro`. The preflight places global
options before `auth status`; this CLI rejects them after the subcommand. No model
workload was started by these checks.

## Windows EPERM investigation

The broad workflow file reproduced EPERM at the queued-variant fixture's immediate
`rmSync`. That test created a RunManager and never disposed it. It now cancels and
awaits its runs, shuts down lifecycle work, disposes the manager, flushes the store,
and awaits the existing bounded asynchronous temporary-directory remover. The
previously failing case passes. Two completed skill-chain fixtures also used
immediate synchronous removal; they now await the same existing remover.

This fixes demonstrated test teardown defects; it does not claim every Windows
EPERM has the same cause. Instrumentation at the dispatch-engine fixture's EPERM
captured four still-live Git children (`config --get-regexp`, `show`,
`for-each-ref`, and `remote get-url origin`), all with null exit codes. Active
resource metadata contained process/pipe handles and timers, with no filesystem
watcher. Waiting for RunManager inactivity had not waited for this background Git
bookkeeping. That fixture now awaits lifecycle shutdown and asynchronous removal
too. This was a test-harness deletion race with Cezar Git bookkeeping, not evidence
of an escaped mock-agent tree. The old broad suite also has a reproducible CRLF fixture
assertion and unrelated legacy failures. No platform skips or new sleep loops were
added. Windows Job Object tests independently verify descendant termination,
unrelated-process survival, and uncertain proof when the supervisor is killed.
Queue tests verify that uncertain proof blocks retries and worktree mutation.
The system-prompt fixture reproduced the same immediate-removal problem in a
targeted run; it now awaits cancellation, lifecycle shutdown, disposal and removal,
and that regression passes too. No test timeout was increased.

The new revocation test also found a bridge reporting race: RunManager publishes
`cancelled` before process teardown settles. The bridge now waits for that teardown
before recording the final claim. The test failed with an unnecessarily uncertain
claim before this fix and passes with confirmed cleanup afterwards. A missing
cleanup proof still retains an uncertain claim.

## Exact task and approval

Use the existing enrolled isolated home:
`F:\Github\cezar\.ai\cezar\m1c1-enrollment-home`.
The preparation script creates a fresh repository at:
`F:\Github\cezar\.ai\cezar\m1c1-enrollment-home\roadmap\disposable\finite-sum`.
It preserves the existing credential, old authorizations and execution claims;
it does not create an approval or dispatch work. Workspace concurrency becomes
one and automatic usage-limit resumption is disabled.

| Approval field | Value |
| --- | --- |
| Repository / project | `local/finite-sum` / `finite-sum` |
| Task ID | `finite-sum-one` |
| Requirement | Implement `sum(a, b)` for finite numbers; throw `TypeError` for non-number or non-finite inputs |
| Mutable scope | `sum.mjs` only |
| Execution mode / runner | `claude-pro` / `claude` |
| Workflow / model | `queue-claude-pro-verify` / `sonnet` |
| Attempts | 2 total provider starts, at most one correction |
| Turns | 8 per provider process |
| Time limits | 180 seconds per provider process; 15 seconds per verification; 420 seconds from claim |
| Verifier | `cezar:sum-verify`: installed Node running bundled `scripts/queue-sum-verify.mjs` |
| Grant expiry | Exact timestamp displayed when Prepare is clicked, one hour from that click |
| Approval ceremony | A new two-minute Windows Hello challenge for this exact real grant |
| Completion | Successful fixed tests, confirmed cleanup, then human review; no acceptance or merge |

The verifier runs assertions for positive, negative, zero and fractional addition,
and rejects strings, null, undefined, NaN and infinities. It evaluates the function
with no Node APIs in a bounded VM context; each evaluation has a one-second cap.
The verifier lives outside the writable worktree and its SHA-256 is included in the
signed workflow revision. The template deliberately fails the verifier initially.

This repository was prepared and checked on this machine. Its initial verifier
fails with `Not implemented`, as intended. At the final read-only inspection it
had **zero real grants and zero execution claims**. The existing owner credential
remains enrolled. Exact revisions for this checkout and installed Node path:

- Task SHA-256: `aa7e17f94cc5c9895ac3df3415eea1e190965b9a47b92513f345c22fa170fa19`
- Workflow SHA-256: `7cb0f97fd7e694cdae10d5574406bb31e64434c290183f1a8267b1bdfa7d9283`

The workflow revision includes absolute verifier/Node paths and verifier contents;
moving the installation changes it and requires a new approval.

For reproducibility, preparation after building uses the following command. It has
already run here; rerunning refuses to overwrite the existing fixture:

```powershell
node packages/cezar/scripts/prepare-guarded-queue.mjs F:\Github\cezar\.ai\cezar\m1c1-enrollment-home
```

For the future approval session, run the built cockpit as Daniel, from this checkout,
with the following process environment. Keep real dispatch disabled while reviewing:

```powershell
$env:CEZ_HOME = 'F:\Github\cezar\.ai\cezar\m1c1-enrollment-home'
$env:CEZ_DRY_RUN = '1'
$env:CEZ_QUEUE_REAL = '0'
$env:CEZ_AUTONAME = '0'
$env:CEZ_AUTOMATIONS = '0'
$env:CEZ_DISPATCH = '0'
$env:CEZ_SKILLS_AUTO_UPDATE = '0'
$env:CEZ_NO_BANNER = '1'
$env:CEZ_TELEMETRY = '0'
node packages/cezar/dist/index.js serve --port 4878 --repo F:\Github\cezar\.ai\cezar\m1c1-enrollment-home\roadmap\disposable\finite-sum
```

Use the same hostname as the enrolled credential (`localhost` versus `127.0.0.1`
matters to WebAuthn). Prepare `finite-sum-one`, inspect the displayed real-mode
warning, revisions, limits and expiry, then sign with Windows Hello. The old mock
approval cannot authorize this task. **Do not run the following until the owner
explicitly approves the supervised launch:** in a second Daniel-owned PowerShell
with the same `CEZ_HOME` and disabling settings, set `CEZ_DRY_RUN=0`, set
`CEZ_QUEUE_REAL=1`, then explicitly dispatch `finite-sum-one`. No timer is involved.
The exact future command, **not executed during this milestone**, is:

```powershell
$env:CEZ_DRY_RUN = '0'
$env:CEZ_QUEUE_REAL = '1'
node packages/cezar/dist/index.js roadmap queue dispatch finite-sum-one
```

The approval-only launcher is also prepared locally at
`.ai/cezar/m1c1-enrollment-home/start-finite-sum-cockpit.ps1`. It checks Daniel's
Windows identity, sets the environment above, and starts only the foreground
cockpit with real dispatch disabled. It has not been launched.

## Remaining limits and verification record

The CLI permission system is not an OS security sandbox. This is a controlled,
marked fixture running under the trusted Windows account and installed Cezar/Claude
code. Windows Job Objects supervise process lifetime, not filesystem access or
network egress. Managed Claude policy still has higher precedence; the guarded
authentication check and restrictive flags fail closed on known incompatibilities.
No real-provider prompt or tool use has yet validated this version's live behavior.

Expiry/revocation/total-deadline cancellation is checked at boundaries and on a
five-second heartbeat, followed by supervised termination. It cannot retract a
completed action or guarantee immediate cancellation. A crash or uncertain cleanup
requires manual inspection; it never unlocks a retry automatically. Reusing another
`CEZ_HOME` is outside the single-home queue concurrency boundary.

Validation on Windows (2026-10-27), using mocks only:

| Gate | Result |
| --- | --- |
| Full typecheck | Passed |
| Focused queue / owner authorization / process ownership / Job Object / CLI policy / API contracts | 12 files passed; 51 tests passed, 20 existing platform-specific skips |
| Targeted variant and skill-chain teardown regressions | 3 passed |
| Native CLI discovery and system-prompt teardown regressions | 2 passed; discovery test also explicitly failed with the source fix removed |
| Dispatch teardown regression | Previously reproduced EPERM; passed after lifecycle shutdown and asynchronous removal |
| Broad Vitest, two workers, bail on first failure | Not green: 53 passed, 1 failed at `git-worktree.test.ts:98`; `worktreeSizeBytes` invokes Unix `du`, unavailable in this Windows context |
| Node unit tests | 40 passed, 2 existing skips |
| Production build and tarball content gate | Passed; 938 packaged files, including 109 cockpit files; existing chunk-size warning only |
| Package install / CLI tests | 25 passed, including packaged verifier presence and supervised mock cleanup |

Earlier broad runs also exposed the fixed teardown races, a five-second legacy
system-prompt timeout, and a CRLF assertion. These are recorded rather than hidden
by broad skips or longer test timeouts. The package auth-rejection fixture now
explicitly selects its own mock shim even when the parent command sets dry-run.
Local detailed evidence is in `.ai/cezar/m1c2-*.log` (ignored runtime artifacts).

**READY — awaiting owner approval for ONE supervised real Claude task.**
This readiness applies only to the prepared local fixture and the exact policy
above. The broad legacy suite is not green. No real provider has been launched;
the next step is Daniel's new Windows Hello approval, followed by a separately
authorized, supervised explicit dispatch.

## Approval UI follow-up (2026-10-28)

After preserving and removing the unrelated untracked mock `notes.md` trace, the
fixture guard passes. The live `POST /api/v1/workspace/roadmap-queue/owner/grant/start`
returns HTTP 200 with the correct finite-sum grant proposal and authentication
options. The browser's Prepare handler also receives the proposal. There is no
current fixture, request-validation or authorization rejection, and the cockpit's
stderr log contains no error for the request. Historical requests were not logged,
so their exact responses cannot be reconstructed.

The UI previously placed both successful preparation details and errors above the
wide queue table, without focus or feedback next to the clicked button. Preparation
now shows a progress label and opens a focused, scrollable review dialog. Failures
show the HTTP status and server reason beside that task's Prepare button; malformed
error responses retain their HTTP status. Signing errors also remain visible inside
the dialog. Preparation never invokes Windows Hello automatically.

Component regressions cover successful preparation without signing, HTTP 409 fixture
rejection, HTTP 503 non-JSON failure and successful retry. All three fail against the
previous UI and pass after the fix. The existing server, its dry-run flags, task and
workflow revisions, grants and enrolled credential are unchanged. Only unsigned,
short-lived preparation challenges are created while verifying Prepare.

The rebuilt page on port 4878 was checked in the browser: clicking Prepare opens
the exact finite-sum proposal and the Windows Hello verification button. No signing
was performed; the live queue still reports mock-only mode, zero real grants and
zero finite-sum attempts. Typecheck, four focused tests, 40 Node unit tests (two
existing skips), the production build and all 25 package tests pass. The broad
Vitest run stops at the existing five-second worktree-lifecycle test timeout
(`sweeps the last PR head ref only after reclaim teardown removes its worktree`);
its timeout and coverage were not changed.
