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
  if (process.platform !== 'win32') reasons.push('Windows mock bridge is required');
  if (!process.env.CEZ_HOME) reasons.push('An isolated CEZ_HOME is required');
  const auth = state.authorizations.find((entry) => same(entry.repo, repo) && same(entry.taskId, taskId));
  const row = queuePreview(state).rows.find((entry) => same(entry.repo, repo) && same(entry.id, taskId));
  if (!row || row.status !== 'ready') reasons.push(`Task is ${row?.status ?? 'missing'}: ${row?.reason ?? 'unknown identity'}`);
  const { allowed, project, roadmap, root } = await taskContext(state, repo, taskId);
  if (!allowed?.projectId || !project || !root) reasons.push('Repository is not explicitly allowlisted to a readable registered project');
  if (!roadmap) reasons.push('No immutable local roadmap task identity');
  if (row?.source === 'github' && !roadmap) reasons.push('Discovered GitHub issue needs a linked local roadmap task before authorization');
  if (roadmap?.githubIssue !== undefined) {
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
    const sandbox = await realpath(join(cezarHomeDir(), 'roadmap', 'disposable')).catch(() => undefined);
    if (!sandbox || !inside(sandbox, root) || !existsSync(join(root, '.cezar-disposable'))) reasons.push('Project is not inside the marked disposable CEZ_HOME sandbox');
  }
  if (!state.ownerAuthenticator || !auth?.credentialId || auth.credentialId !== state.ownerAuthenticator.id || !auth.approvedAt || auth.audit.at(-1)?.actor !== 'windows-hello') reasons.push('No cryptographically verified Windows Hello grant');
  if (!auth || auth.revokedAt) reasons.push('Authorization is missing or revoked');
  if (auth && Date.parse(auth.expiresAt) <= Date.now()) reasons.push('Authorization expired');
  if (auth && (auth.repo !== repo || auth.taskId !== taskId || auth.repositoryRoot !== root || auth.scope !== '.' || auth.agent !== row?.proposedAgent || auth.workflow !== row?.proposedWorkflow || auth.workflow !== 'queue-mock-verify' || auth.requireReview !== true || auth.verificationCommand !== 'cezar:mock-verify')) reasons.push('Grant repository, scope, runner, workflow, or review policy differs from the selected work');
  if (auth && (!Number.isInteger(auth.maxAttempts) || auth.maxAttempts < 1 || auth.maxAttempts > 3)) reasons.push('Attempt limit is outside the mock safety bound');
  if (auth && roadmap && auth.taskRevision !== createHash('sha256').update(JSON.stringify(roadmap)).digest('hex')) reasons.push('Task revision changed after approval');
  if (auth && auth.workflowRevision !== queueMockWorkflowRevision(auth.agent, auth.maxAttempts)) reasons.push('Workflow revision changed after approval');
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
  return queueResponseSchema.parse({ ...preview, mode: 'mock-only', rows,
    nextTaskId: rows.find((row) => row.executionEligible)?.id ?? null,
    recentDecisions: [...preview.recentDecisions, ...state.executionClaims.slice(-10).map((entry) => ({ at: entry.heartbeatAt, reason: `${entry.taskId}: ${entry.state}${entry.reason ? ` — ${entry.reason}` : ''}` }))].slice(-20),
  });
}

export async function dispatchOneMockTask(taskId?: string, issueReader: GithubIssueReader = readGithubIssue): Promise<{ taskId: string; runId: string; status: string }> {
  const snapshot = await readQueueState();
  const candidates = queuePreview(snapshot).rows.filter((row) => row.status === 'ready' && (!taskId || same(row.id, taskId)));
  let chosen: typeof candidates[number] | undefined;
  for (const row of candidates) if ((await queueExecutionReasons(snapshot, row.repo, row.id, undefined, issueReader)).length === 0) { chosen = row; break; }
  if (!chosen) throw new Error(taskId ? `Task ${taskId} is not eligible: ${candidates.length ? (await queueExecutionReasons(snapshot, candidates[0]!.repo, candidates[0]!.id, undefined, issueReader)).join('; ') : 'no ready match'}` : 'No authorized mock task is eligible');
  const repo = chosen.repo; const id = chosen.id;
  const context = await taskContext(snapshot, repo, id);
  const root = context.root!;
  const auth = snapshot.authorizations.find((entry) => same(entry.repo, repo) && same(entry.taskId, id))!;
  const workflow = queueMockWorkflow(auth.agent, auth.maxAttempts);
  const owner = `${process.pid}:${randomUUID()}`;
  const claim = await claimExecution(repo, id, owner, (current) => {
    const currentAuth = current.authorizations.find((entry) => same(entry.repo, repo) && same(entry.taskId, id));
    const currentRow = queuePreview(current).rows.find((entry) => same(entry.repo, repo) && same(entry.id, id));
    return !!currentAuth && currentAuth.approvedAt === auth.approvedAt && currentAuth.credentialId === auth.credentialId && !currentAuth.revokedAt && Date.parse(currentAuth.expiresAt) > Date.now() && currentRow?.status === 'ready';
  });
  if (!claim) throw new Error('Another Cezar instance claimed or changed this task');
  const guard = async (run: RunRecord, githubMode: 'verify' | 'skip' = 'verify'): Promise<string | undefined> => {
    if (run.queueExecution?.claimId !== claim.claimId || run.queueExecution.generation !== claim.generation || run.queueExecution.mockOnly !== true) return 'Queue run provenance does not match its claim';
    if (run.workflow !== workflow.name || run.runner !== auth.agent || run.worktree === false) return 'Queue run execution parameters changed';
    if (JSON.stringify(run.workflowDef) !== JSON.stringify(workflow)) return 'Queue workflow definition differs from the approved fixed mock workflow';
    const current = await readQueueState();
    const currentAuth = current.authorizations.find((entry) => same(entry.repo, repo) && same(entry.taskId, id));
    if (currentAuth?.approvedAt !== auth.approvedAt || currentAuth?.credentialId !== auth.credentialId) return 'Owner grant changed after this execution was claimed';
    const reasons = await queueExecutionReasons(current, repo, id, claim, issueReader, githubMode);
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
    const run = manager.startRun(workflow, { task: `Mock task ${id}: ${chosen.title}. Approved scope: ${auth.scope}.`,
      runner: auth.agent, autonomous: true, worktree: true, generateFollowups: false,
      queueExecution: { repo, taskId: id, claimId: claim.claimId, generation: claim.generation, mockOnly: true } });
    if (!await advanceExecutionClaim(claim, { state: 'running', runId: run.id })) throw new Error('Execution claim was lost before launch');
    timer = setInterval(() => { void (async () => {
      const reason = await guard(store!.getRun(run.id)!, 'skip');
      if (reason || !await advanceExecutionClaim(claim, { state: 'running', runId: run.id })) manager?.cancel(run.id);
    })().catch(() => manager?.cancel(run.id)); }, 5_000);
    const final = await new Promise<RunRecord>((finish) => {
      const current = store!.getRun(run.id);
      if (current && ['review', 'failed', 'cancelled', 'done'].includes(current.status)) { finish(current); return; }
      const listener = (record: RunRecord) => {
        if (record.id !== run.id || !['review', 'failed', 'cancelled', 'done'].includes(record.status)) return;
        store!.off('run', listener);
        finish(record);
      };
      store!.on('run', listener);
    });
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
