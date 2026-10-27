import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dispatchOneQueueTask, queueExecutionReasons } from './bridge.ts';
import { readQueueState, saveQueueInput, updateQueue, claimExecution } from './queue.ts';
import { queueRealWorkflowRevision, REAL_QUEUE_TASK, REAL_QUEUE_WORKFLOW, REAL_QUEUE_TOTAL_MS } from './real-workflow.ts';
import { realFixtureFiles } from './real-fixture.ts';
import { ClaudeCliRunner } from '../core/claude-cli-runner.ts';
import { removeTempDir } from '../test-fixtures/remove-temp-dir.testkit.ts';
import { RunStore } from '../runs/store.ts';
import { RunManager } from '../workflows/run.ts';
import { createRealQueueRunner } from '../core/runner-factory.ts';
import { beginOwnerGrant, finishOwnerDecision } from './owner-auth.ts';
import { generateRunName } from '../runs/auto-name.ts';

// Test substitution only: production has no environment switch to fake Pro authentication.
vi.mock('../core/real-queue-policy.ts', async importOriginal => ({
  ...await importOriginal<object>(), assertClaudeProAuthentication: vi.fn(async () => undefined),
}));
vi.mock('../core/runner-factory.ts', async importOriginal => ({
  ...await importOriginal<object>(), createRealQueueRunner: vi.fn(() => new ClaudeCliRunner({
    bin: fileURLToPath(new URL('./__fixtures__/real-queue-agent.mjs', import.meta.url)),
  })),
}));
vi.mock('../runs/auto-name.ts', async importOriginal => ({ ...await importOriginal<object>(), generateRunName: vi.fn() }));

describe('guarded real queue with a supervised mock provider', () => {
  let home: string; let root: string;
  const repo = 'local/guarded-sum'; const id = 'sum-one';
  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'cez-real-queue-'));
    root = join(home, 'roadmap/disposable/sum');
    mkdirSync(join(root, '.ai/cezar'), { recursive: true });
    for (const [name, content] of Object.entries(realFixtureFiles)) writeFileSync(join(root, name), content);
    writeFileSync(join(root, '.ai/cezar/config.json'), JSON.stringify({ reviewGate: true }));
    execFileSync('git', ['init', '-q', '-b', 'main', root]);
    execFileSync('git', ['-C', root, 'config', 'core.autocrlf', 'false']);
    execFileSync('git', ['-C', root, 'add', '.']);
    execFileSync('git', ['-C', root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'fixture']);
    writeFileSync(join(home, 'config.json'), JSON.stringify({ resources: { maxParallel: 1 }, projects: [
      { id: 'sum', root, name: 'sum', addedAt: new Date().toISOString(), lastOpenedAt: new Date().toISOString(), source: 'local' },
    ] }));
    vi.stubEnv('CEZ_HOME', home); vi.stubEnv('CEZ_QUEUE_REAL', '1'); vi.stubEnv('CEZ_DRY_RUN', '0');
    await saveQueueInput({ allowedRepositories: [{ repo, projectId: 'sum' }], roadmaps: [
      { id, repo, title: REAL_QUEUE_TASK, priority: 1, approval: 'approved', preferredRunner: 'claude', workflow: REAL_QUEUE_WORKFLOW, dependencies: [], blockers: [] },
    ], githubIssues: [], runningTaskIds: [], completedTaskIds: [] });
    const now = new Date().toISOString();
    await updateQueue(state => {
      state.ownerAuthenticator = { id: 'test', publicKey: 'test', counter: 1, enrolledAt: now };
      state.authorizations = [{ taskId: id, repo, repositoryRoot: root, scope: 'sum.mjs', agent: 'claude',
        executionMode: 'claude-pro', workflow: REAL_QUEUE_WORKFLOW, workflowRevision: queueRealWorkflowRevision(2),
        taskRevision: createHash('sha256').update(JSON.stringify(state.input.roadmaps[0])).digest('hex'),
        expiresAt: new Date(Date.now() + 300_000).toISOString(), maxAttempts: 2, requireReview: true, verificationCommand: 'cezar:sum-verify',
        credentialId: 'test', approvedAt: now, audit: [{ at: now, action: 'created', actor: 'windows-hello' }] }];
    });
  });
  afterEach(async () => { vi.unstubAllEnvs(); vi.clearAllMocks(); await removeTempDir(home); });
  const reasons = async () => queueExecutionReasons(await readQueueState(), repo, id);

  it('requires enablement independently from a matching real grant', async () => {
    expect(await reasons()).toEqual([]);
    vi.stubEnv('CEZ_QUEUE_REAL', '0');
    await expect(dispatchOneQueueTask(id)).rejects.toThrow('CEZ_QUEUE_REAL');
    vi.stubEnv('CEZ_QUEUE_REAL', '1'); vi.stubEnv('CEZ_DRY_RUN', '1');
    await expect(dispatchOneQueueTask(id)).rejects.toThrow('dry run');
  });
  it.each(['agent', 'executionMode', 'scope', 'workflowRevision', 'expiresAt', 'revokedAt', 'taskRevision'] as const)('fails closed on %s mismatch', async field => {
    await updateQueue(state => {
      const auth = state.authorizations[0]!;
      if (field === 'agent') auth.agent = 'codex';
      else if (field === 'executionMode') auth.executionMode = 'mock';
      else if (field === 'expiresAt' || field === 'revokedAt') auth[field] = new Date(Date.now() - 1000).toISOString();
      else auth[field] = 'changed';
    });
    await expect(dispatchOneQueueTask(id)).rejects.toThrow('not eligible');
    expect((await readQueueState()).executionClaims).toHaveLength(0);
  });
  it('corrects failed verification and reaches review once, with confirmed cleanup', async () => {
    vi.stubEnv('CEZ_AUTONAME', '1');
    const results = await Promise.allSettled([dispatchOneQueueTask(id), dispatchOneQueueTask(id)]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const result = results.find(result => result.status === 'fulfilled');
    const store = RunStore.open(join(root, '.ai/cezar'));
    const record = store.listRuns()[0]!;
    expect(result?.status === 'fulfilled' && result.value.status, JSON.stringify(record)).toBe('review');
    expect(record.queueExecution?.mockOnly).toBe(false);
    expect(record.queueExecution?.providerStarts).toBe(2);
    expect(generateRunName).not.toHaveBeenCalled();
    expect(record.agentCleanup).toBe('confirmed');
    expect(record.steps.find(step => step.id === 'implement')?.iterations).toBe(2);
    await expect(dispatchOneQueueTask(id)).rejects.toThrow('not eligible');
  }, 120_000);
  it('retains failed verification without retrying beyond the approved cap', async () => {
    await updateQueue(state => { state.authorizations[0]!.maxAttempts = 1; state.authorizations[0]!.workflowRevision = queueRealWorkflowRevision(1); });
    expect((await dispatchOneQueueTask(id)).status).toBe('failed');
    const record = RunStore.open(join(root, '.ai/cezar')).listRuns()[0]!;
    expect(record.steps.find(step => step.id === 'verify')?.status, JSON.stringify(record)).toBe('failed');
    await expect(dispatchOneQueueTask(id)).rejects.toThrow('not eligible');
  }, 120_000);
  it('blocks another task on crash residue or uncertain cleanup and enforces total deadline', async () => {
    const claim = await claimExecution(repo, id, 'dead-worker', () => true);
    expect(claim).toBeDefined();
    await expect(dispatchOneQueueTask(id)).rejects.toThrow('not eligible');
    await updateQueue(state => { state.executionClaims[0]!.state = 'uncertain'; state.executionClaims[0]!.taskId = 'another-task'; });
    expect(await reasons()).toContain('Another execution or uncertain cleanup holds the single queue slot');
    await updateQueue(state => { state.executionClaims[0]!.state = 'running'; state.executionClaims[0]!.taskId = id; });
    const own = { ...claim!, claimedAt: new Date(Date.now() - REAL_QUEUE_TOTAL_MS - 1).toISOString() };
    expect(await queueExecutionReasons(await readQueueState(), repo, id, own)).toContain('Approved total execution deadline exceeded');
  });
  it('never requeues a queue run on recovery even when cleanup was confirmed', async () => {
    const store = RunStore.open(join(root, '.ai/cezar'));
    const run = store.createRun({ title: 'interrupted', task: 'fixture', workflow: REAL_QUEUE_WORKFLOW, steps: [] });
    store.updateRun(run.id, { status: 'queued', agentCleanup: 'confirmed', queueExecution: {
      repo, taskId: id, claimId: '11111111-1111-4111-8111-111111111111', generation: 1, mockOnly: false,
    } });
    const manager = new RunManager(store, root);
    try { await manager.recover(); expect(store.getRun(run.id)?.status).toBe('failed'); expect(manager.isActive(run.id)).toBe(false); }
    finally { manager.dispose(); store.flush(); }
  });
  it('refuses remote-bearing and altered disposable repositories', async () => {
    execFileSync('git', ['-C', root, 'remote', 'add', 'origin', 'https://github.com/example/repo']);
    expect(await reasons()).toContain('Real fixture must have no Git remotes');
  });

  it('requires a new signature binding the real execution mode', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const jwk = publicKey.export({ format: 'jwk' });
    const cose = Buffer.concat([Buffer.from('a5010203262001215820', 'hex'), Buffer.from(jwk.x!, 'base64url'), Buffer.from('225820', 'hex'), Buffer.from(jwk.y!, 'base64url')]);
    const credentialId = Buffer.from('real-test-credential').toString('base64url');
    await updateQueue(state => { state.authorizations = []; state.ownerAuthenticator = { id: credentialId, publicKey: cose.toString('base64url'), counter: 0, enrolledAt: new Date().toISOString() }; });
    const request = { taskId: id, repo, scope: 'sum.mjs', agent: 'claude', workflow: REAL_QUEUE_WORKFLOW,
      expiresAt: new Date(Date.now() + 60_000).toISOString(), maxAttempts: 2, requireReview: true, verificationCommand: 'cezar:sum-verify', executionMode: 'claude-pro' };
    const origin = 'http://localhost:4888';
    const assertion = (challenge: string) => {
      const client = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge, origin }));
      const auth = Buffer.concat([createHash('sha256').update('localhost').digest(), Buffer.from([5, 0, 0, 0, 1])]);
      return { id: credentialId, rawId: credentialId, type: 'public-key' as const, clientExtensionResults: {}, response: {
        clientDataJSON: client.toString('base64url'), authenticatorData: auth.toString('base64url'),
        signature: sign('sha256', Buffer.concat([auth, createHash('sha256').update(client).digest()]), privateKey).toString('base64url'),
      } };
    };
    await expect(beginOwnerGrant(origin, { ...request, executionMode: 'mock' })).rejects.toThrow('Claude Pro');
    const altered = await beginOwnerGrant(origin, request);
    await updateQueue(state => { state.pendingOwnerChallenge!.grant!.executionMode = 'mock'; });
    await expect(finishOwnerDecision(origin, 'grant', assertion(altered.options.challenge))).rejects.toThrow('exact scope');
    const fresh = await beginOwnerGrant(origin, request);
    expect(await finishOwnerDecision(origin, 'grant', assertion(fresh.options.challenge))).toMatchObject({ executionMode: 'claude-pro', scope: 'sum.mjs', agent: 'claude' });
  });

  it('retains the worktree and blocks verification, retries and mutation when cleanup proof is uncertain', async () => {
    vi.mocked(createRealQueueRunner).mockImplementationOnce(() => {
      const runner = new ClaudeCliRunner({ bin: fileURLToPath(new URL('./__fixtures__/real-queue-agent.mjs', import.meta.url)) });
      const start = runner.startSession.bind(runner);
      runner.startSession = (...args) => new Proxy(start(...args), { get: (target, key) => key === 'processQuiescent' ? false : Reflect.get(target, key) });
      return runner;
    });
    const result = await dispatchOneQueueTask(id);
    expect(result.status).toBe('uncertain');
    const store = RunStore.open(join(root, '.ai/cezar'));
    const run = store.getRun(result.runId)!;
    expect(run.agentCleanup).toBe('uncertain');
    expect(run.steps.find(step => step.id === 'verify')?.status).not.toBe('done');
    expect(run.queueExecution?.providerStarts).toBe(1);
    await expect(dispatchOneQueueTask(id)).rejects.toThrow('uncertain cleanup');
    const manager = new RunManager(store, root);
    try {
      expect(await manager.cancelAndWait(run.id)).toBe(false);
      const mutate = vi.fn(async () => undefined);
      await expect(manager.lifecycle.withWorktreeMutation(run.id, mutate)).rejects.toThrow('unconfirmed');
      expect(mutate).not.toHaveBeenCalled();
    } finally { manager.dispose(); store.flush(); }
  }, 120_000);

  it('cancels an active supervised mock after revocation, with no verification or retry', async () => {
    vi.mocked(createRealQueueRunner).mockImplementationOnce(() => {
      const runner = new ClaudeCliRunner({ bin: fileURLToPath(new URL('./__fixtures__/real-queue-agent.mjs', import.meta.url)) });
      const start = runner.startSession.bind(runner);
      runner.startSession = (spec, ...rest) => start({ ...spec, env: { TEST_QUEUE_WAIT: '1' } }, ...rest);
      return runner;
    });
    const running = dispatchOneQueueTask(id);
    await expect.poll(async () => (await readQueueState()).executionClaims[0]?.state, { timeout: 10_000 }).toBe('running');
    await expect.poll(() => RunStore.open(join(root, '.ai/cezar'), { keepLive: true }).listRuns()[0]?.agentCleanup, { timeout: 15_000 }).toBe('pending');
    await updateQueue(state => { state.authorizations[0]!.revokedAt = new Date().toISOString(); });
    const result = await running;
    expect(result.status).toBe('failed');
    const record = RunStore.open(join(root, '.ai/cezar')).getRun(result.runId)!;
    expect(record.agentCleanup).toBe('confirmed');
    expect(record.queueExecution?.providerStarts).toBe(1);
    expect(record.steps.find(step => step.id === 'verify')?.status).not.toBe('done');
  }, 45_000);

  it('serializes different tasks through the same durable queue slot', async () => {
    await updateQueue(state => {
      const task = { ...state.input.roadmaps[0]!, id: 'sum-two' };
      state.input.roadmaps.push(task);
      state.authorizations.push({ ...state.authorizations[0]!, taskId: task.id,
        taskRevision: createHash('sha256').update(JSON.stringify(task)).digest('hex') });
    });
    const results = await Promise.allSettled([dispatchOneQueueTask(id), dispatchOneQueueTask('sum-two')]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect((await readQueueState()).executionClaims).toHaveLength(1);
  }, 120_000);
});
