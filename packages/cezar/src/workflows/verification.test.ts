import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClaudeCliRunner } from '../core/claude-cli-runner.ts';
import { RunStore } from '../runs/store.ts';
import { removeTempDir, stopRuns } from '../test-fixtures/remove-temp-dir.testkit.ts';
import { RunManager } from './run.ts';
import type { WorkflowDef } from './types.ts';

const exec = promisify(execFile);
describe('Cezar-owned verification with a mock Claude and a real disposable npm project', () => {
  let root: string; let manager: RunManager; let store: RunStore;
  beforeEach(async () => {
    vi.stubEnv('CEZ_DRY_RUN', '1');
    root = mkdtempSync(join(tmpdir(), 'cez-verify-'));
    await exec('git', ['init', '-q', '-b', 'main'], { cwd: root });
    writeFileSync(join(root, 'package.json'), JSON.stringify({ private: true, scripts: { test: 'node verify.cjs' } }));
    writeFileSync(join(root, 'verify.cjs'), `const fs=require('node:fs');const n=fs.readFileSync('notes.md','utf8').trim().split('\\n').length; console.log(n<2?'EXPECTED_TEST_FAILURE':'VERIFIED');process.exit(n<2?1:0);`);
    await exec('git', ['add', '.'], { cwd: root });
    await exec('git', ['-c', 'user.name=Test', '-c', 'user.email=test@local', 'commit', '-qm', 'fixture'], { cwd: root });
    store = RunStore.open(join(root, '.ai/cezar')); manager = new RunManager(store, root);
  });
  afterEach(async () => { vi.restoreAllMocks(); await stopRuns(manager, store, 12_000); store.flush(); await removeTempDir(root); vi.unstubAllEnvs(); });

  const workflow = (command = 'npm test', max = 2): WorkflowDef => ({ name: 'verified', source: 'file', steps: [
    { id: 'implement', prompt: '{{task}}', allowedTools: ['Read', 'Edit', 'Write', 'Grep', 'Glob'] },
    { id: 'verify', command, timeoutSeconds: 30, onFail: { retry: 'implement', max, retryOn: [1] } },
  ] });
  async function settled(id: string) {
    await expect.poll(() => manager.isActive(id), { timeout: 45_000, interval: 100 }).toBe(false);
    return store.getRun(id)!;
  }

  it('returns failures to the restricted agent, then requires a successful recorded test before review', async () => {
    const starts = vi.spyOn(ClaudeCliRunner.prototype, 'startSession');
    const run = manager.startRun(workflow(), { task: 'mock:done implement', worktree: false });
    const result = await settled(run.id);
    expect(['done', 'review']).toContain(result.status);
    expect(result.steps[0]?.iterations).toBe(2);
    expect(result.steps[1]?.status).toBe('done');
    expect(starts.mock.calls.every(([spec]) => !spec.allowedTools?.includes('Bash'))).toBe(true);
    expect(starts.mock.calls[1]?.[0].userPrompt).toContain('EXPECTED_TEST_FAILURE');
    const checks = store.readEvents(run.id).filter(event => event.type === 'check-output');
    expect(checks.map(event => event.exitCode)).toEqual([1, 0]);
    expect(checks[1]?.text).toContain('VERIFIED');
    expect(result.agentCleanup).toBe('confirmed');

    // Reopening the session invalidates the earlier result, so the test is run again.
    expect(manager.continueRun(run.id, { text: 'mock:done correction' }).ok).toBe(true);
    await settled(run.id);
    expect(store.readEvents(run.id).filter(event => event.type === 'check-output')).toHaveLength(3);
  }, 60_000);

  it('caps correction attempts and cannot mark failed verification ready for acceptance', async () => {
    const run = manager.startRun(workflow('echo ALWAYS_FAIL; exit 1', 1), { task: 'mock:done implement', worktree: false });
    const result = await settled(run.id);
    expect(result.status).toBe('failed'); expect(result.steps[0]?.iterations).toBe(2);
    expect(manager.finish(run.id)).toBe(false);
    expect(store.readEvents(run.id).filter(event => event.type === 'check-output')).toHaveLength(2);
  }, 60_000);

  it('does not retry a timed-out verification command', async () => {
    const def = workflow('sleep 30'); def.steps[1]!.timeoutSeconds = 1;
    const run = manager.startRun(def, { task: 'mock:done implement', worktree: false });
    const result = await settled(run.id);
    expect(result.status).toBe('failed'); expect(result.steps[0]?.iterations).toBe(1);
    expect(result.error).toContain('automatic retry is blocked');
    expect(result.agentCleanup).toBe('confirmed');
  }, 45_000);

  it('waits for check cleanup when cancelled instead of reusing an earlier agent result', async () => {
    const run = manager.startRun(workflow('echo CHECK_STARTED; sleep 30'), { task: 'mock:done implement', worktree: false });
    await expect.poll(() => store.getRun(run.id)?.agentCleanup === 'pending' && store.getRun(run.id)?.steps[1]?.status === 'running', { timeout: 15_000 }).toBe(true);
    expect(await manager.cancelAndWait(run.id)).toBe(true);
    expect(store.getRun(run.id)).toMatchObject({ status: 'cancelled', agentCleanup: 'confirmed' });
    expect(manager.isActive(run.id)).toBe(false);
  }, 30_000);
});
