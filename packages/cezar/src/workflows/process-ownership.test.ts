import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentRunResult, AgentSession } from '../core/agent-runner.ts';
import { RunStore } from '../runs/store.ts';
import { removeTempDir } from '../test-fixtures/remove-temp-dir.testkit.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { RunManager } from './run.ts';

describe('durable agent process ownership', () => {
  const dirs: string[] = [];
  const managers: RunManager[] = [];
  afterEach(async () => { managers.forEach(manager => manager.dispose()); await removeTempDir(...dirs); });

  it.each([true, false])('records cleanup proof %s and blocks unsafe continuation and removal after restart', async quiescent => {
    const root = mkdtempSync(join(tmpdir(), 'cez-agent-proof-')); dirs.push(root);
    const path = join(root, '.ai/cezar'); const store = RunStore.open(path);
    const manager = new RunManager(store, root, { semaphore: new WorkspaceSemaphore({ initial: { maxParallel: 0 } }) }); managers.push(manager);
    const run = store.createRun({ title: 'proof', workflow: 'test', task: 'test', steps: [{ id: 'work', name: 'Work', kind: 'agent' }] });
    store.updateStep(run.id, 'work', { sessionId: 'owned-session', backend: 'claude' });
    store.updateRun(run.id, { status: 'failed' });
    let resolve!: (result: AgentRunResult) => void; let reject!: (error: Error) => void;
    let proof = false;
    const session: AgentSession = { result: new Promise((yes, no) => { resolve = yes; reject = no; }), get processQuiescent() { return proof; }, open: true, sendMessage: () => true, end() {}, interrupt() {} };
    const owned = (manager as unknown as { ownAgentSession(id: string, session: AgentSession): AgentSession }).ownAgentSession(run.id, session);
    expect(RunStore.open(path).getRun(run.id)?.agentCleanup).toBe('pending');
    expect(manager.continueRun(run.id).ok).toBe(false);
    expect(await manager.cancelAndWait(run.id)).toBe(false);
    proof = quiescent;
    if (quiescent) resolve({ text: 'done', tokensUsed: 0, toolCalls: [] }); else reject(new Error('supervisor lost'));
    await owned.result.catch(() => {});
    if (!quiescent) { store.updateRun(run.id, { status: 'running' }); store.flush(); }
    const reopened = RunStore.open(path, { keepLive: true });
    expect(reopened.getRun(run.id)?.agentCleanup).toBe(quiescent ? 'confirmed' : 'uncertain');
    const recovered = new RunManager(reopened, root, { semaphore: new WorkspaceSemaphore({ initial: { maxParallel: 0 } }) }); managers.push(recovered);
    if (!quiescent) { await recovered.recover(); expect(reopened.getRun(run.id)?.status).toBe('failed'); }
    expect(await recovered.cancelAndWait(run.id)).toBe(quiescent);
    if (!quiescent) expect(recovered.continueRun(run.id)).toMatchObject({ ok: false, error: expect.stringContaining('unconfirmed') });
  });
});
