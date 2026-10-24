import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClaudeCliRunner } from '../core/claude-cli-runner.ts';
import { reviewPreflightError } from '../runs/review-gate.ts';
import { RunStore } from '../runs/store.ts';
import { removeTempDir, stopRuns } from '../test-fixtures/remove-temp-dir.testkit.ts';
import { RunManager } from './run.ts';
import type { WorkflowDef } from './types.ts';

const exec = promisify(execFile);
const verified: WorkflowDef = {
  name: 'requires-review', source: 'file', requiresReview: true,
  steps: [
    { id: 'implement', prompt: '{{task}}', runner: 'claude', allowedTools: ['Read', 'Edit', 'Write'] },
    { id: 'verify', command: 'npm test', timeoutSeconds: 30, onFail: { retry: 'implement', max: 2, retryOn: [1] } },
  ],
};

describe('Milestone 0G: required review and genuine mock correction', () => {
  let root: string;
  let manager: RunManager;
  let store: RunStore;

  beforeEach(async () => {
    vi.stubEnv('CEZ_DRY_RUN', '1');
    vi.stubEnv('CEZ_AUTONAME', '0');
    root = mkdtempSync(join(tmpdir(), 'cez-0g-correction-'));
    await exec('git', ['init', '-q', '-b', 'main'], { cwd: root });
    const { mkdirSync } = await import('node:fs');
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src/slug.js'), "export function slugifyTitle(_input) { throw Error('not implemented'); }\n");
    writeFileSync(join(root, 'package.json'), JSON.stringify({ private: true, type: 'module', scripts: { test: 'node verify.mjs' } }));
    writeFileSync(join(root, 'verify.mjs'), `import { slugifyTitle } from './src/slug.js';
if (slugifyTitle('  Hello   WORLD  ') !== 'hello-world') {
  console.error('EXPECTED_SLUG_FAILURE: slugifyTitle returned an incorrect value');
  process.exitCode = 1;
} else console.log('SLUG_VERIFIED');
`);
    await exec('git', ['add', '.'], { cwd: root });
    await exec('git', ['-c', 'user.name=Test', '-c', 'user.email=test@local', 'commit', '-qm', 'fixture'], { cwd: root });
    store = RunStore.open(join(root, '.ai/cezar'));
    manager = new RunManager(store, root);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await stopRuns(manager, store, 12_000);
    store.flush();
    await removeTempDir(root);
    vi.unstubAllEnvs();
  });

  async function settled(id: string) {
    await expect.poll(() => manager.isActive(id), { timeout: 45_000, interval: 100 }).toBe(false);
    return store.getRun(id)!;
  }

  it('refuses a promised review before any agent session when the effective gate is off', async () => {
    vi.stubEnv('CEZ_REVIEW_GATE', '0');
    const starts = vi.spyOn(ClaudeCliRunner.prototype, 'startSession');
    const run = manager.startRun(verified, { task: 'mock:repair-slug mock:done', worktree: true });
    const result = await settled(run.id);
    expect(result.status).toBe('failed');
    expect(result.error).toContain('review gate is disabled');
    expect(starts).not.toHaveBeenCalled();
  });

  it('refuses when the project toggle disables review despite CEZ_REVIEW_GATE=1', async () => {
    vi.stubEnv('CEZ_REVIEW_GATE', '1');
    writeFileSync(join(root, '.ai/cezar/config.json'), JSON.stringify({ reviewGate: false }));
    const starts = vi.spyOn(ClaudeCliRunner.prototype, 'startSession');
    const run = manager.startRun(verified, { task: 'mock:repair-slug mock:done', worktree: true });
    expect((await settled(run.id)).error).toContain('review gate is disabled');
    expect(starts).not.toHaveBeenCalled();
  });

  it('honors the project override and allows autonomy with mandatory review in a worktree', () => {
    expect(reviewPreflightError(true, { reviewGate: false }, { worktree: true }, { CEZ_REVIEW_GATE: '1' })).toContain('disabled');
    expect(reviewPreflightError(true, { reviewGate: true }, { worktree: true }, { CEZ_REVIEW_GATE: '0' })).toBeUndefined();
    expect(reviewPreflightError(true, { reviewGate: true }, { autonomous: true, worktree: true })).toBeUndefined();
    expect(reviewPreflightError(true, { reviewGate: true }, { worktree: false })).toContain('worktree');
    expect(reviewPreflightError(true, { reviewGate: true, taskWorkspace: 'in-place' }, {})).toContain('worktree');
  });

  it('keeps a verified autonomous workflow at manual review', async () => {
    vi.stubEnv('CEZ_REVIEW_GATE', '1');
    const run = manager.startRun(verified, { task: 'mock:repair-slug mock:done', worktree: true, autonomous: true });
    const result = await settled(run.id);
    expect(result.status).toBe('review');
    expect(store.readEvents(run.id).filter((event) => event.type === 'check-output').map((event) => event.exitCode)).toEqual([1, 0]);
  }, 60_000);

  it('fails on a real code defect, returns the output, repairs code, verifies, then reaches review', async () => {
    vi.stubEnv('CEZ_REVIEW_GATE', '1');
    const starts = vi.spyOn(ClaudeCliRunner.prototype, 'startSession');
    const run = manager.startRun(verified, { task: 'mock:repair-slug mock:done', worktree: true });
    const result = await settled(run.id);
    const checks = store.readEvents(run.id).filter((event) => event.type === 'check-output');
    expect(checks.map((event) => event.exitCode)).toEqual([1, 0]);
    expect(checks[0]?.text).toContain('EXPECTED_SLUG_FAILURE');
    expect(starts.mock.calls[1]?.[0].userPrompt).toContain('EXPECTED_SLUG_FAILURE');
    expect(checks[1]?.text).toContain('SLUG_VERIFIED');
    expect(readFileSync(join(result.worktreePath!, 'src/slug.js'), 'utf8')).toContain('input.trim()');
    expect(result.steps.map((step) => step.iterations)).toEqual([2, 2]);
    expect(result.status).toBe('review');
    expect(result.agentCleanup).toBe('confirmed');
    expect(manager.finish(run.id)).toBe(true); // a human action, never automatic
  }, 60_000);

  it('exhausts two correction attempts with the defect still present and blocks acceptance', async () => {
    vi.stubEnv('CEZ_REVIEW_GATE', '1');
    const run = manager.startRun(verified, { task: 'mock:stubborn-slug mock:done', worktree: true });
    const result = await settled(run.id);
    const checks = store.readEvents(run.id).filter((event) => event.type === 'check-output');
    expect(checks.map((event) => event.exitCode)).toEqual([1, 1, 1]);
    expect(result.steps[0]?.iterations).toBe(3);
    expect(result.status).toBe('failed');
    expect(manager.finish(run.id)).toBe(false);
  }, 90_000);
});
