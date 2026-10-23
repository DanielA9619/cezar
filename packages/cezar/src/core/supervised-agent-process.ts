import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PassThrough, Writable } from 'node:stream';

const supervision = new WeakMap<ChildProcessWithoutNullStreams, { closed: Promise<void>; quiescent: boolean }>();

/** Stdio stays a byte stream; the helper owns the job, never the agent protocol. */
export function spawnAgentProcess(file: string, args: string[], options: SpawnOptionsWithoutStdio, beforeStart?: () => void): ChildProcessWithoutNullStreams {
  if (process.platform !== 'win32') return spawn(file, args, options);
  beforeStart?.();
  const nonce = `__cezar_${randomUUID().replaceAll('-', '')}`;
  const helper = join(dirname(fileURLToPath(import.meta.url)), '../../src/worktree-lifecycle/windows-process-supervisor.ps1');
  const payload = Buffer.from(JSON.stringify({ executable: file, args, cwd: options.cwd, nonce, interactive: true })).toString('base64');
  const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const child = spawn(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helper], { ...options, windowsHide: true });
  const controls = child.stdin;
  const rawStderr = child.stderr;
  const killHelper = child.kill.bind(child);
  let killTimer: NodeJS.Timeout | undefined;
  const state = { quiescent: false, closed: new Promise<void>(resolve => child.once('close', () => resolve())) };
  supervision.set(child, state);
  controls.on('error', () => {});
  const control = (line: string, callback?: (error?: Error | null) => void): void => {
    if (controls.destroyed) { callback?.(); return; }
    controls.write(`${line}\n`, callback);
  };
  const stdin = new Writable({
    write(chunk: Buffer, _encoding, callback) { control(`DATA ${chunk.toString('base64')}`, callback); },
    final(callback) { control('EOF', callback); },
  });
  stdin.on('error', () => {});
  const stderr = new PassThrough();
  let pending = '';
  rawStderr.setEncoding('utf8');
  rawStderr.on('data', (chunk: string) => {
    pending += chunk;
    let end: number;
    while ((end = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, end + 1); pending = pending.slice(end + 1);
      if (new RegExp(`^${nonce}:\\d+:quiescent\\r?\\n$`).test(line)) state.quiescent = true;
      else stderr.write(line);
    }
    // A provider's unbounded diagnostic line must not grow the control parser forever.
    if (pending.length > 64 * 1024) { stderr.write(pending); pending = ''; }
  });
  rawStderr.on('end', () => { stderr.end(pending); });
  Object.assign(child, { stdin, stderr });
  child.kill = (signal = 'SIGTERM') => {
    if (child.exitCode !== null || child.signalCode !== null) return false;
    control(signal === 'SIGKILL' || signal === 9 ? 'STOP' : 'TERM');
    // A broken supervisor cannot hold the cockpit forever. Missing proof stays uncertain.
    killTimer ??= setTimeout(() => killHelper('SIGKILL'), 15_000);
    killTimer.unref();
    return true;
  };
  child.once('close', () => { if (killTimer) clearTimeout(killTimer); controls.destroy(); stdin.destroy(); });
  control(payload);
  control('START');
  return child;
}

export function agentProcessQuiescent(child: ChildProcessWithoutNullStreams): boolean | undefined {
  return supervision.get(child)?.quiescent;
}

/** A dead wrapper alone is never proof that its owned descendants exited. */
export async function confirmAgentProcessExit(child: ChildProcessWithoutNullStreams): Promise<void> {
  const state = supervision.get(child);
  if (!state) return;
  await state.closed;
  if (!state.quiescent) throw new Error('Agent process-tree termination is uncertain; automatic retry and worktree cleanup are blocked');
}
