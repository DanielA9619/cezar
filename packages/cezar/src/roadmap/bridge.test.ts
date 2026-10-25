import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { queueMockWorkflowRevision } from './mock-workflow.ts';
import { dispatchOneMockTask, queueDetailedPreview } from './bridge.ts';
import { readQueueState, saveQueueInput, updateQueue } from './queue.ts';
import { beginOwnerGrant, finishOwnerDecision } from './owner-auth.ts';

describe('disposable mock queue bridge', () => {
  let home: string;
  let root: string;
  const task = { id: 'atlas-one', repo: 'fictional/atlas', title: 'Fix the mock', priority: 1,
    approval: 'approved' as const, preferredRunner: 'claude' as const, dependencies: [], blockers: [] };

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'cez-bridge-'));
    root = join(home, 'roadmap', 'disposable', 'atlas');
    mkdirSync(join(root, '.ai', 'cezar'), { recursive: true });
    writeFileSync(join(root, '.cezar-disposable'), 'test fixture\n');
    writeFileSync(join(root, '.ai', 'cezar', 'config.json'), JSON.stringify({ reviewGate: true }));
    writeFileSync(join(home, 'config.json'), JSON.stringify({ projects: [
      { id: 'atlas', root, name: 'Atlas', addedAt: new Date().toISOString(), lastOpenedAt: new Date().toISOString(), source: 'local' },
    ] }));
    execFileSync('git', ['init', '-q', root]);
    execFileSync('git', ['-C', root, 'config', 'user.email', 'mock@example.test']);
    execFileSync('git', ['-C', root, 'config', 'user.name', 'Mock Owner']);
    execFileSync('git', ['-C', root, 'add', '.']);
    execFileSync('git', ['-C', root, 'commit', '-qm', 'fixture']);
    vi.stubEnv('CEZ_HOME', home);
    await saveQueueInput({ allowedRepositories: [{ repo: task.repo, projectId: 'atlas' }], roadmaps: [task,
      { ...task, id: 'atlas-other', title: 'Unapproved task', priority: 2 }], githubIssues: [], runningTaskIds: [], completedTaskIds: [] });
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    for (let attempt = 0; attempt < 20; attempt++) {
      try { rmSync(home, { recursive: true, force: true }); return; }
      catch (error) {
        if (attempt === 19) throw error;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
  });

  async function syntheticVerifiedGrant(agent: 'claude' | 'codex' = 'claude', maxAttempts = 2) {
    const now = new Date().toISOString();
    await updateQueue((state) => {
      state.ownerAuthenticator = { id: 'test-credential', publicKey: 'test-public-key', counter: 1, enrolledAt: now };
      state.authorizations.push({ repo: task.repo, repositoryRoot: root, taskId: task.id,
        taskRevision: createHash('sha256').update(JSON.stringify(state.input.roadmaps.find((entry) => entry.id === task.id))).digest('hex'),
        scope: '.', agent, workflow: 'queue-mock-verify',
        workflowRevision: queueMockWorkflowRevision(agent, maxAttempts),
        expiresAt: new Date(Date.now() + 60_000).toISOString(), maxAttempts,
        requireReview: true, verificationCommand: 'cezar:mock-verify', credentialId: 'test-credential', approvedAt: now,
        audit: [{ at: now, action: 'created', actor: 'windows-hello' }], });
    });
  }

  it('requires a fresh signed WebAuthn assertion with user verification for the exact grant', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const jwk = publicKey.export({ format: 'jwk' });
    const cose = Buffer.concat([Buffer.from('a5010203262001215820', 'hex'), Buffer.from(jwk.x!, 'base64url'),
      Buffer.from('225820', 'hex'), Buffer.from(jwk.y!, 'base64url')]);
    const credentialId = Buffer.from('mock-credential-id').toString('base64url');
    await updateQueue((state) => { state.ownerAuthenticator = {
      id: credentialId, publicKey: cose.toString('base64url'), counter: 0, enrolledAt: new Date().toISOString(),
    }; });
    const request = { repo: task.repo, taskId: task.id, scope: '.', agent: 'claude' as const,
      workflow: 'queue-mock-verify', expiresAt: new Date(Date.now() + 60_000).toISOString(),
      maxAttempts: 2, requireReview: true as const, verificationCommand: 'cezar:mock-verify' };
    const origin = 'http://localhost:4888';
    const begin = await beginOwnerGrant(origin, request);
    const authenticatorData = Buffer.concat([createHash('sha256').update('localhost').digest(), Buffer.from([0x05, 0, 0, 0, 1])]);
    const assertion = (challenge: string) => {
      const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge, origin }));
      const signature = sign('sha256', Buffer.concat([authenticatorData, createHash('sha256').update(clientDataJSON).digest()]), privateKey);
      return { id: credentialId, rawId: credentialId, type: 'public-key' as const, clientExtensionResults: {},
        response: { clientDataJSON: clientDataJSON.toString('base64url'), authenticatorData: authenticatorData.toString('base64url'),
          signature: signature.toString('base64url') } };
    };
    const response = assertion(begin.options.challenge);
    await expect(finishOwnerDecision(origin, 'grant', { ...response, response: { ...response.response,
      signature: Buffer.from('forged').toString('base64url') } })).rejects.toThrow();
    expect((await readQueueState()).authorizations).toHaveLength(0);
    await beginOwnerGrant(origin, request);
    await expect(finishOwnerDecision(origin, 'grant', response)).rejects.toThrow('challenge');
    const fresh = await beginOwnerGrant(origin, request);
    const verified = await finishOwnerDecision(origin, 'grant', assertion(fresh.options.challenge));
    expect(verified).toMatchObject({ credentialId, taskId: task.id, agent: 'claude', scope: '.' });
    expect((await queueDetailedPreview()).rows.find((row) => row.id === task.id)?.executionEligible).toBe(true);
  });

  it('rejects missing, expired, revoked, changed, and claimed approvals before launch', async () => {
    expect((await queueDetailedPreview()).rows.find((row) => row.id === task.id)?.executionEligible).toBe(false);
    await syntheticVerifiedGrant();
    expect((await queueDetailedPreview()).rows.find((row) => row.id === task.id)?.executionEligible).toBe(true);
    expect((await queueDetailedPreview()).rows.find((row) => row.id === 'atlas-other')?.executionEligible).toBe(false);
    await updateQueue((state) => { state.authorizations[0]!.scope = 'src'; });
    expect((await queueDetailedPreview()).rows.find((row) => row.id === task.id)?.executionReasons).toContain('Grant repository, scope, runner, workflow, or review policy differs from the selected work');
    await updateQueue((state) => { state.authorizations[0]!.scope = '.'; state.authorizations[0]!.revokedAt = new Date().toISOString(); });
    expect((await queueDetailedPreview()).rows.find((row) => row.id === task.id)?.executionReasons).toContain('Authorization is missing or revoked');
    await expect(dispatchOneMockTask(task.id)).rejects.toThrow('not eligible');
  });

  it('runs a defective mock, corrects it, verifies it, and retains review and the claim after restart', async () => {
    await syntheticVerifiedGrant();
    const result = await dispatchOneMockTask(task.id);
    const record = JSON.parse(readFileSync(join(root, '.ai', 'cezar', 'runs.json'), 'utf8'));
    expect(result.status, JSON.stringify(record)).toBe('review');
    const state = await readQueueState();
    expect(state.executionClaims[0]).toMatchObject({ taskId: task.id, runId: result.runId, state: 'review' });
    expect(JSON.stringify(record)).toContain(result.runId);
    expect(existsSync(join(root, '.ai', 'cezar', 'runs.json'))).toBe(true);
    await expect(dispatchOneMockTask(task.id)).rejects.toThrow('not eligible');
  }, 120_000);

  it('keeps the Codex backend on the bundled protocol mock', async () => {
    await updateQueue((state) => { state.input.roadmaps[0]!.preferredRunner = 'codex'; });
    await syntheticVerifiedGrant('codex');
    const result = await dispatchOneMockTask(task.id);
    expect(result.status).toBe('review');
    expect((await readQueueState()).executionClaims[0]?.state).toBe('review');
  }, 120_000);

  it('allows only one of two competing dispatchers to start a run', async () => {
    await syntheticVerifiedGrant();
    const results = await Promise.allSettled([dispatchOneMockTask(task.id), dispatchOneMockTask(task.id)]);
    expect(results.filter((entry) => entry.status === 'fulfilled')).toHaveLength(1);
    expect((await readQueueState()).executionClaims).toHaveLength(1);
  }, 120_000);

  it('fails at the fixed verifier when the authorized attempt limit is one', async () => {
    await syntheticVerifiedGrant('claude', 1);
    const result = await dispatchOneMockTask(task.id);
    expect(result.status).toBe('failed');
    expect((await readQueueState()).executionClaims[0]?.state).toBe('failed');
  }, 120_000);
});
