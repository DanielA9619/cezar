import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { executeLifecycleCommand, probeLifecycleProcess, type LifecycleExecutorOutput } from './executor.ts';

let cwd: string;
beforeEach(async () => { cwd = await mkdtemp(join(tmpdir(), 'lifecycle-executor-')); vi.stubEnv('CEZ_DRY_RUN', '0'); });
afterEach(async () => { vi.unstubAllEnvs(); await rm(cwd, { recursive: true, force: true }); });
describe('supervised lifecycle executor', () => {
  it('runs in the given cwd, closes stdin, and emits stdout/stderr', async () => {
    const frames: LifecycleExecutorOutput[] = [];
    const result = await executeLifecycleCommand({ command: 'pwd; echo err >&2; read ignored || echo closed', cwd, onOutput: frame => { frames.push(frame); } });
    expect(result).toMatchObject({ state: 'succeeded', exitCode: 0, quiescent: true });
    expect(frames.map(frame => frame.text).join('')).toContain(cwd.split(/[\\/]/).at(-1));
    expect(frames).toContainEqual({ stream: 'stderr', text: 'err\n' });
    expect(frames.map(frame => frame.text).join('')).toContain('closed');
    expect(await probeLifecycleProcess({...result.identity!, quiescent: result.quiescent}, process.platform)).toBe('quiescent');
  });
  it('does not execute the command until its start identity is durably saved', async () => {
    const result = await executeLifecycleCommand({ command: 'echo unsafe > marker', cwd, onStart: async () => { throw new Error('read-only state'); } });
    expect(result).toMatchObject({ state: 'failed', quiescent: true });
    await expect(readFile(join(cwd, 'marker'))).rejects.toThrow();
  });
  it('records nonzero exit and missing Bash without throwing', async () => {
    expect(await executeLifecycleCommand({ command: 'exit 7', cwd })).toMatchObject({ state: 'failed', exitCode: 7 });
    expect(await executeLifecycleCommand({ command: 'true', cwd, bashPath: '/missing/cezar-bash' })).toMatchObject({ state: 'failed', quiescent: true });
  });
  it('times out silent children and confirms process-group quiescence', async () => {
    const result = await executeLifecycleCommand({ command: 'sleep 30 & wait', cwd, timeoutSeconds: 1 });
    expect(result).toMatchObject({ state: 'interrupted', quiescent: true });
    expect(result.reason).toContain('timeout');
  });
  it('stops on abort and dry-run never launches commands', async () => {
    const controller = new AbortController();
    const running = executeLifecycleCommand({ command: 'sleep 30', cwd, signal: controller.signal, onStart: async () => { setTimeout(() => controller.abort(), 100); } });
    expect(await running).toMatchObject({ state: 'interrupted', quiescent: true });
    expect(await executeLifecycleCommand({ command: 'touch marker', cwd, dryRun: true })).toMatchObject({ state: 'succeeded' });
    await expect(readFile(join(cwd, 'marker'))).rejects.toThrow();
  });
  it('redacts known secrets and token patterns split across pipe frames', async () => {
    const secret = 'a-very-private-secret-value'; vi.stubEnv('LIFECYCLE_TEST_TOKEN', secret);
    const frames: LifecycleExecutorOutput[] = [];
    const result = await executeLifecycleCommand({ command: "printf a-very-private-; sleep 0.15; printf 'secret-value\\n'; printf ghp_abcdefghijk; sleep 0.15; printf 'lmnopqrstuvwxyz\\n'", cwd, onOutput: frame => { frames.push(frame); } });
    expect(result.state).toBe('succeeded');
    const output = frames.map(frame => frame.text).join('');
    expect(output).not.toContain(secret); expect(output).not.toContain('ghp_');
    expect(output).toContain('[REDACTED]');
  });
  it('reports output persistence failure after exit without leaving a timer', async () => {
    const result = await executeLifecycleCommand({ command: 'echo output', cwd, onOutput: async () => { throw new Error('disk full'); } });
    expect(result).toMatchObject({ state: 'failed', quiescent: true, reason: 'Could not persist lifecycle output' });
  });
  it('bounds output while draining chatty processes and overlong lines', async () => {
    const frames: LifecycleExecutorOutput[] = [];
    const result = await executeLifecycleCommand({ command: "head -c 1800000 /dev/zero | tr '\\0' x; echo; yes short | head -n 200000", cwd, onOutput: frame => { frames.push(frame); } });
    expect(result).toMatchObject({ state: 'succeeded', truncated: true, quiescent: true });
    expect(frames.every(frame => Buffer.byteLength(frame.text) <= 16384)).toBe(true);
    expect(frames.reduce((sum, frame) => sum + Buffer.byteLength(frame.text), 0)).toBeLessThanOrEqual(1048700);
  });
});

describe('Windows persisted-process safety', () => {
  it('treats an unconfirmed Windows PID as unknown instead of trusting PID liveness', async () => {
    const identity = {pid: process.pid, hostname: hostname(), startedAt: new Date().toISOString(), quiescent: false};
    await expect(probeLifecycleProcess(identity, 'win32')).resolves.toBe('unknown');
    expect(() => process.kill(process.pid, 0)).not.toThrow();
  });
  it('accepts only a persisted positive quiescence result during Windows recovery', async () => {
    const identity = {pid: process.pid, hostname: hostname(), startedAt: new Date().toISOString(), quiescent: true};
    await expect(probeLifecycleProcess(identity, 'win32')).resolves.toBe('quiescent');
    await expect(probeLifecycleProcess({...identity, hostname: 'another-host'}, 'win32')).resolves.toBe('unknown');
  });
});

const windowsOnly = process.platform === 'win32' ? describe : describe.skip;
const execFileAsync = promisify(execFile);
const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
async function sleepExecutable(name: string): Promise<string> {
  const source = join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'usr', 'bin', 'sleep.exe');
  const target = join(cwd, name);
  await copyFile(source, target);
  return target;
}
async function processExists(name: string): Promise<boolean> {
  const {stdout} = await execFileAsync(powershell, ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Name '${name}' -ErrorAction SilentlyContinue | Measure-Object).Count`], {windowsHide: true});
  return Number(stdout.trim()) > 0;
}
async function waitForProcess(name: string, expected: boolean): Promise<void> {
  const until = Date.now() + 5000;
  while (Date.now() < until) { if (await processExists(name) === expected) return; await new Promise(resolve => setTimeout(resolve, 50)); }
  expect(await processExists(name)).toBe(expected);
}

windowsOnly('Windows Job Object supervision', () => {
  it('finishes normally and kills nested child and grandchild processes that outlive Bash', async () => {
    const token = `cez${randomUUID().replaceAll('-', '')}`;
    await sleepExecutable(`${token}root.exe`); await sleepExecutable(`${token}child.exe`); await sleepExecutable(`${token}grand.exe`);
    const result = await executeLifecycleCommand({command: `./${token}root.exe 30 & (./${token}child.exe 30 & (./${token}grand.exe 30 & wait); wait) & exit 0`, cwd});
    expect(result).toMatchObject({state: 'succeeded', exitCode: 0, quiescent: true});
    for (const suffix of ['root', 'child', 'grand']) await waitForProcess(`${token}${suffix}`, false);
  });

  it('confirms timeout and user cancellation after killing nested descendants', async () => {
    const token = `cez${randomUUID().replaceAll('-', '')}`;
    await sleepExecutable(`${token}child.exe`); await sleepExecutable(`${token}grand.exe`);
    const command = `echo running; ./${token}child.exe 30 & (./${token}grand.exe 30 & wait); wait`;
    let timeoutOutput = '';
    const timed = await executeLifecycleCommand({command, cwd, timeoutSeconds: 5, onOutput: async frame => {
      timeoutOutput += frame.text;
      if (timeoutOutput.includes('running')) { await waitForProcess(`${token}grand`, true); }
    }});
    expect(timed).toMatchObject({state: 'interrupted', quiescent: true});
    expect(timeoutOutput).toContain('running');
    await waitForProcess(`${token}child`, false); await waitForProcess(`${token}grand`, false);

    const controller = new AbortController();
    let cancelOutput = '';
    const cancelled = executeLifecycleCommand({command, cwd, signal: controller.signal, onOutput: async frame => {
      cancelOutput += frame.text;
      if (cancelOutput.includes('running')) { await waitForProcess(`${token}grand`, true); controller.abort(); controller.abort(); }
    }});
    expect(await cancelled).toMatchObject({state: 'interrupted', quiescent: true});
    expect(cancelOutput).toContain('running');
    await waitForProcess(`${token}child`, false); await waitForProcess(`${token}grand`, false);
  }, 20_000);

  it('kills Job Object descendants when the supervisor is forcibly terminated and reports uncertainty', async () => {
    const token = `cez${randomUUID().replaceAll('-', '')}`;
    await sleepExecutable(`${token}child.exe`); await sleepExecutable(`${token}grand.exe`);
    let identity: {pid: number} | undefined;
    const run = executeLifecycleCommand({command: `./${token}child.exe 30 & (./${token}grand.exe 30 & wait); wait`, cwd, onStart: async value => { identity = value; }});
    await waitForProcess(`${token}grand`, true);
    expect(identity?.pid).toBeGreaterThan(0);
    process.kill(identity!.pid, 'SIGKILL'); // Exact helper PID returned by this execution's onStart checkpoint.
    expect(await run).toMatchObject({state: 'failed', quiescent: false});
    await waitForProcess(`${token}child`, false); await waitForProcess(`${token}grand`, false);
  }, 20_000);
});
