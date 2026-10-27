import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { cezarHomeDir } from '../paths.ts';
import { loadWorkspaceConfig } from '../workspace/config.ts';
import { RunStore, type RunRecord } from '../runs/store.ts';
import { readRunIndexDiagnostic } from '../runs/run-index.ts';
import { reviewPreflightError } from '../runs/review-gate.ts';
import { loadConfig } from '../config.ts';
import { RunManager } from '../workflows/run.ts';
import { queueMockWorkflow, queueMockWorkflowRevision } from './mock-workflow.ts';
import { advanceExecutionClaim, claimExecution, queuePreview, readQueueState, type ExecutionClaim, type QueueState } from './queue.ts';
import { queueResponseSchema, type QueueResponse } from '@open-mercato/cezar-contract';
import { freshGithubSnapshot, readGithubIssue, sameGithubSnapshot, type GithubIssueReader } from './github-issue-verifier.ts';
import { REAL_QUEUE_WORKFLOW, REAL_QUEUE_SCOPE, REAL_QUEUE_VERIFY, REAL_QUEUE_TOTAL_MS, REAL_QUEUE_TASK, queueRealWorkflow, queueRealWorkflowRevision } from './real-workflow.ts';
import { assertClaudeProAuthentication } from '../core/real-queue-policy.ts';
import { assertRealFixture } from './real-fixture.ts';

function same(a: string, b: string): boolean { return a.toLowerCase() === b.toLowerCase(); }
function inside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

async function taskContext(state: QueueState, repo: string, taskId: string) {
  const allowed = state.input.allowedRepositories.find((entry) => same(entry.repo, repo));
  const workspace = await loadWorkspaceConfig();
  const project = workspace.projects.find((entry) => entry.id === allowed?.projectId);
  const roadmap = state.input.roadmaps.find((entry) => same(entry.repo, repo) && same(entry.githubIssue ? `${entry.repo}#${entry.githubIssue}` : entry.id, taskId));
  const root = project ? await realpath(project.root).catch(() => undefined) : undefined;
  return { allowed, project, roadmap, root };
}

/** These checks are repeated before launch and at every RunManager spawn. */
export async function queueExecutionReasons(state: QueueState, repo: string, taskId: string, ownClaim?: ExecutionClaim,
  issueReader: GithubIssueReader = readGithubIssue, githubMode: 'verify' | 'defer' | 'skip' = 'verify'): Promise<string[]> {
  const reasons: string[] = [];
  if (process.platform !== 'win32') reasons.push('Windows execution bridge is required');
  if (!process.env.CEZ_HOME) reasons.push('An isolated CEZ_HOME is required');
  const auth = state.authorizations.find((entry) => same(entry.repo, repo) && same(entry.taskId, taskId));
  const row = queuePreview(state).rows.find((entry) => same(entry.repo, repo) && same(entry.id, taskId));
  const real = row?.proposedWorkflow === REAL_QUEUE_WORKFLOW;
  if (real && (process.env.CEZ_QUEUE_REAL !== '1' || process.env.CEZ_DRY_RUN === '1')) reasons.push('Real queue execution requires CEZ_QUEUE_REAL=1 and dry run disabled');
  if (real && (auth?.executionMode !== 'claude-pro' || auth.agent !== 'claude')) reasons.push('A new Windows Hello grant for real Claude Pro execution is required');
  if (!real && auth?.executionMode && auth.executionMode !== 'mock') reasons.push('Real grant cannot authorize a mock workflow');
  if (state.executionClaims.some((entry) => entry.claimId !== ownClaim?.claimId && ['claimed', 'running', 'uncertain'].includes(entry.state))) reasons.push('Another execution or uncertain cleanup holds the single queue slot');
  if (real && ownClaim && Date.now() >= Date.parse(ownClaim.claimedAt) + REAL_QUEUE_TOTAL_MS) reasons.push('Approved total execution deadline exceeded');
  if (!row || row.status !== 'ready') reasons.push(`Task is ${row?.status ?? 'missing'}: ${row?.reason ?? 'unknown identity'}`);
  const { allowed, project, roadmap, root } = await taskContext(state, repo, taskId);
  if (!allowed?.projectId || !project || !root) reasons.push('Repository is not explicitly allowlisted to a readable registered project');
  if (!roadmap) reasons.push('No immutable local roadmap task identity');
  if (row?.source === 'github' && !roadmap) reasons.push('Discovered GitHub issue needs a linked local roadmap task before authorization');
  if (roadmap?.githubIssue !== undefined) {
    if (real) reasons.push('Real execution of GitHub-linked issues is disabled');
    if (!auth?.githubSnapshot || auth.githubSnapshot.issueNumber !== roadmap.githubIssue) reasons.push('Approval lacks the linked GitHub issue snapshot');
    else if (githubMode === 'defer') reasons.push('Direct GitHub issue verification is required at dispatch');
    else if (githubMode === 'verify' && root) {
      try {
        const evidence = await issueReader(root, repo, roadmap.githubIssue);
        if (!freshGithubSnapshot(evidence.snapshot) || evidence.snapshot.issueNumber !== roadmap.githubIssue) reasons.push('Direct GitHub issue evidence is stale or mismatched');
        if (evidence.state !== 'open' || !evidence.labels.includes('roadmap-approved')) reasons.push('GitHub issue closed or lost planning approval');
        if (!sameGithubSnapshot(auth.githubSnapshot, evidence.snapshot)) reasons.push('GitHub issue identity or revision changed after approval');
      } catch (error) { reasons.push(error instanceof Error ? error.message : 'Direct GitHub verification failed'); }
    }
  } else if (auth?.githubSnapshot) reasons.push('Approval refers to a GitHub issue, but task is now local-only');
  if (root) {
    if (real) {
      try { await assertRealFixture(root); }
      catch (error) { reasons.push(error instanceof Error ? error.message : 'Real fixture check failed'); }
    }
    const sandbox = await realpath(join(cezarHomeDir(), 'roadmap', 'disposable')).catch(() => undefined);
    if (!sandbox || !inside(sandbox, root) || !existsSync(join(root, '.cezar-disposable'))) reasons.push('Project is not inside the marked disposable CEZ_HOME sandbox');
  }
  if (!state.ownerAuthenticator || !auth?.credentialId || auth.credentialId !== state.ownerAuthenticator.id || !auth.approvedAt || auth.audit.at(-1)?.actor !== 'windows-hello') reasons.push('No cryptographically verified Windows Hello grant');
  if (!auth || auth.revokedAt) reasons.push('Authorization is missing or revoked');
  if (auth && Date.parse(auth.expiresAt) <= Date.now()) reasons.push('Authorization expired');
  if (auth && (auth.repo !== repo || auth.taskId !== taskId || auth.repositoryRoot !== root || auth.scope !== (real ? REAL_QUEUE_SCOPE : '.') || auth.agent !== row?.proposedAgent || auth.workflow !== row?.proposedWorkflow || auth.workflow !== (real ? REAL_QUEUE_WORKFLOW : 'queue-mock-verify') || auth.requireReview !== true || auth.verificationCommand !== (real ? REAL_QUEUE_VERIFY : 'cezar:mock-verify'))) reasons.push('Grant repository, scope, runner, workflow, or review policy differs from the selected work');
  const validAttempts = !!auth && Number.isInteger(auth.maxAttempts) && auth.maxAttempts >= 1 && auth.maxAttempts <= (real ? 2 : 3);
  if (auth && !validAttempts) reasons.push('Attempt limit is outside the queue safety bound');
  if (auth && roadmap && auth.taskRevision !== createHash('sha256').update(JSON.stringify(roadmap)).digest('hex')) reasons.push('Task revision changed after approval');
  if (auth && validAttempts && auth.workflowRevision !== (real ? queueRealWorkflowRevision(auth.maxAttempts) : queueMockWorkflowRevision(auth.agent, auth.maxAttempts))) reasons.push('Workflow revision changed after approval');
  const claim = state.executionClaims.find((entry) => same(entry.repo, repo) && same(entry.taskId, taskId));
  if (claim && (!ownClaim || claim.claimId !== ownClaim.claimId || claim.generation !== ownClaim.generation || !['claimed', 'running'].includes(claim.state))) reasons.push('Task already has an execution claim; expired heartbeat is not cleanup proof');
  if (root) {
    const runs = readRunIndexDiagnostic(join(root, '.ai', 'cezar'), root);
    const onlyOwnLiveRun = !!ownClaim && runs.state === 'partial' && runs.omittedRuns === 0 &&
      runs.runs.filter((run) => ['queued', 'running', 'waiting'].includes(run.status)).every((run) =>
        run.queueExecution?.claimId === ownClaim.claimId && run.queueExecution.generation === ownClaim.generation);
    if (runs.state !== 'complete' && !onlyOwnLiveRun) reasons.push(runs.reason ?? 'Run index is unreadable');
    if (!ownClaim && runs.runs.some((run) => run.queueExecution && same(run.queueExecution.repo, repo) && same(run.queueExecution.taskId, taskId))) reasons.push('Task already has a persisted execution');
    const config = await loadConfig(root);
    const reviewError = reviewPreflightError(true, config, { autonomous: true, worktree: true });
    if (reviewError) reasons.push(reviewError);
  }
  return reasons;
}

export async function queueDetailedPreview(): Promise<QueueResponse> {
  const state = await readQueueState();
  const preview = queuePreview(state);
  const rows = await Promise.all(preview.rows.map(async (row) => {
    const reasons = await queueExecutionReasons(state, row.repo, row.id, undefined, readGithubIssue, 'defer').catch(() => ['Execution checks could not be completed']);
    const claim = state.executionClaims.find((entry) => same(entry.repo, row.repo) && same(entry.taskId, row.id));
    let attemptsUsed = 0;
    let verificationProgress: string | undefined;
    if (claim?.runId) {
      const root = (await taskContext(state, row.repo, row.id)).root;
      if (root) {
        const record = readRunIndexDiagnostic(join(root, '.ai', 'cezar'), root).runs.find((run) => run.id === claim.runId);
        attemptsUsed = record?.steps.find((step) => step.id === 'implement')?.iterations ?? 0;
        verificationProgress = record?.steps.map((step) => `${step.name}: ${step.status}`).join('; ');
      }
    }
    return { ...row, executionEligible: reasons.length === 0, executionReasons: reasons, attemptsUsed,
      ...(verificationProgress ? { verificationProgress } : {}) };
  }));
  return queueResponseSchema.parse({ ...preview, mode: process.env.CEZ_QUEUE_REAL === '1' ? 'guarded-real' : 'mock-only', rows,
    nextTaskId: rows.find((row) => row.executionEligible)?.id ?? null,
    recentDecisions: [...preview.recentDecisions, ...state.executionClaims.slice(-10).map((entry) => ({ at: entry.heartbeatAt, reason: `${entry.taskId}: ${entry.state}${entry.reason ? ` — ${entry.reason}` : ''}` }))].slice(-20),
  });
}

export async function dispatchOneQueueTask(taskId?: string, issueReader: GithubIssueReader = readGithubIssue): Promise<{ taskId: string; runId: string; status: string }> {
  const snapshot = await readQueueState();
  const candidates = queuePreview(snapshot).rows.filter((row) => row.status === 'ready' && (!taskId || same(row.id, taskId)));
  let chosen: typeof candidates[number] | undefined;
  for (const row of candidates) if ((await queueExecutionReasons(snapshot, row.repo, row.id, undefined, issueReader)).length === 0) { chosen = row; break; }
  if (!chosen) throw new Error(taskId ? `Task ${taskId} is not eligible: ${candidates.length ? (await queueExecutionReasons(snapshot, candidates[0]!.repo, candidates[0]!.id, undefined, issueReader)).join('; ') : 'no ready match'}` : 'No authorized mock task is eligible');
  const repo = chosen.repo; const id = chosen.id;
  const context = await taskContext(snapshot, repo, id);
  const root = context.root!;
  const auth = snapshot.authorizations.find((entry) => same(entry.repo, repo) && same(entry.taskId, id))!;
  const real = auth.executionMode === 'claude-pro';
  if (real && !taskId) throw new Error('Real dispatch requires an explicit task ID');
  if (real) await assertClaudeProAuthentication();
  const workflow = real ? queueRealWorkflow(auth.maxAttempts) : queueMockWorkflow(auth.agent, auth.maxAttempts);
  const owner = `${process.pid}:${randomUUID()}`;
  const claim = await claimExecution(repo, id, owner, (current) => {
    const currentAuth = current.authorizations.find((entry) => same(entry.repo, repo) && same(entry.taskId, id));
    const currentRow = queuePreview(current).rows.find((entry) => same(entry.repo, repo) && same(entry.id, id));
    return !current.executionClaims.some((entry) => ['claimed', 'running', 'uncertain'].includes(entry.state)) && !!currentAuth && JSON.stringify(currentAuth) === JSON.stringify(auth) && !currentAuth.revokedAt && Date.parse(currentAuth.expiresAt) > Date.now() && currentRow?.status === 'ready';
  });
  if (!claim) throw new Error('Another Cezar instance claimed or changed this task');
  const guard = async (run: RunRecord, githubMode: 'verify' | 'skip' = 'verify'): Promise<string | undefined> => {
    if (run.queueExecution?.claimId !== claim.claimId || run.queueExecution.generation !== claim.generation || run.queueExecution.mockOnly !== !real) return 'Queue run provenance does not match its claim';
    if (run.workflow !== workflow.name || run.runner !== auth.agent || run.worktree === false) return 'Queue run execution parameters changed';
    if (JSON.stringify(run.workflowDef) !== JSON.stringify(workflow)) return 'Queue workflow definition differs from the approved fixed workflow';
    if (real && run.worktreePath) await assertRealFixture(run.worktreePath, true);
    if ((run.steps.find(step => step.id === 'implement')?.iterations ?? 0) > auth.maxAttempts) return 'Approved attempt limit exceeded';
    const current = await readQueueState();
    const currentAuth = current.authorizations.find((entry) => same(entry.repo, repo) && same(entry.taskId, id));
    if (JSON.stringify(currentAuth) !== JSON.stringify(auth)) return 'Owner grant changed after this execution was claimed';
    const reasons = await queueExecutionReasons(current, repo, id, claim, issueReader, githubMode);
    if (!reasons.length && real && githubMode === 'verify') await assertClaudeProAuthentication();
    return reasons[0];
  };
  let store: RunStore | undefined;
  let manager: RunManager | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  try {
    const reasons = await queueExecutionReasons(await readQueueState(), repo, id, claim, issueReader);
    if (reasons.length) throw new Error(reasons.join('; '));
    store = RunStore.open(join(root, '.ai', 'cezar'));
    manager = new RunManager(store, root, { queueGuard: guard });
    const run = manager.startRun(workflow, { task: real ? REAL_QUEUE_TASK : `Mock task ${id}: ${chosen.title}. Approved scope: ${auth.scope}.`,
      runner: auth.agent, autonomous: true, worktree: true, generateFollowups: false,
      queueExecution: { repo, taskId: id, claimId: claim.claimId, generation: claim.generation, mockOnly: !real } });
    if (!await advanceExecutionClaim(claim, { state: 'running', runId: run.id })) throw new Error('Execution claim was lost before launch');
    timer = setInterval(() => { void (async () => {
      const reason = await guard(store!.getRun(run.id)!, 'skip');
      if (reason || !await advanceExecutionClaim(claim, { state: 'running', runId: run.id })) manager?.cancel(run.id);
    })().catch(() => manager?.cancel(run.id)); }, 5_000);
    let final = await new Promise<RunRecord>((finish) => {
      const current = store!.getRun(run.id);
      if (current && ['review', 'failed', 'cancelled', 'done'].includes(current.status)) { finish(current); return; }
      const listener = (record: RunRecord) => {
        if (record.id !== run.id || !['review', 'failed', 'cancelled', 'done'].includes(record.status)) return;
        store!.off('run', listener);
        finish(record);
      };
      store!.on('run', listener);
    });
    // Cancellation publishes its terminal status before the supervised process
    // settles. Keep the durable slot until teardown has had a chance to prove
    // quiescence; a timeout still leaves the claim uncertain and blocks reuse.
    if (final.status === 'cancelled') {
      await manager.cancelAndWait(run.id);
      final = store.getRun(run.id)!;
    }
    store.flush({ throwOnError: true });
    const state = final.status === 'review' && final.agentCleanup !== 'pending' && final.agentCleanup !== 'uncertain' ? 'review' : final.agentCleanup === 'pending' || final.agentCleanup === 'uncertain' ? 'uncertain' : 'failed';
    await advanceExecutionClaim(claim, { state, runId: run.id, reason: state === 'review' ? 'Human review required' : final.error ?? final.status });
    return { taskId: id, runId: run.id, status: state };
  } catch (error) {
    await advanceExecutionClaim(claim, { state: 'uncertain', reason: error instanceof Error ? error.message : String(error) });
    throw error;
  } finally {
    if (timer) clearInterval(timer);
    if (manager) { await manager.lifecycle.shutdown(); manager.dispose(); }
    store?.flush({ pretty: true });
  }
}

/** Compatibility entry point retained for mock-only callers. */
export async function dispatchOneMockTask(taskId?: string, issueReader: GithubIssueReader = readGithubIssue) {
  const state = await readQueueState();
  if (queuePreview(state).rows.some(row => (!taskId || same(row.id, taskId)) && row.proposedWorkflow === REAL_QUEUE_WORKFLOW)) throw new Error('Mock dispatch cannot launch a real workflow');
  return dispatchOneQueueTask(taskId, issueReader);
}
