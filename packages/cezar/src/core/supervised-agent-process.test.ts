import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { spawnAgentProcess, confirmAgentProcessExit, agentProcessQuiescent } from './supervised-agent-process.ts';

const fixture = fileURLToPath(new URL('./__fixtures__/supervised-process.mjs', import.meta.url));
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

describe.skipIf(process.platform !== 'win32')('Windows streaming agent supervision', () => {
  async function start(mode = '') {
    const argument = 'unicode λ "quoted" path with spaces\\';
    const child = spawnAgentProcess(process.execPath, [fixture, mode, argument], { cwd: process.cwd(), env: process.env });
    let output = ''; let diagnostics = '';
    child.stdout.on('data', chunk => { output += String(chunk); });
    child.stderr.on('data', chunk => { diagnostics += String(chunk); });
    try {
      await expect.poll(() => output.includes('"ready":true') || child.exitCode !== null, { timeout: 10_000 }).toBe(true);
      expect(output, diagnostics).toContain('"ready":true');
      const pids = JSON.parse(output.split('\n')[0]!);
      expect(pids.argv).toBe(argument);
      expect(alive(pids.child)).toBe(true); expect(alive(pids.grandchild)).toBe(true);
      return { child, pids, output: () => output };
    } catch (error) { child.kill('SIGKILL'); await confirmAgentProcessExit(child).catch(() => {}); throw error; }
  }

  it('preserves stdin, streaming, large frames, argv quoting and normal nested cleanup', async () => {
    const run = await start();
    const text = `unicode λ "quoted" \\path\\ ${'x'.repeat(128 * 1024)}`;
    try {
      run.child.stdin.write(`${text}\n`);
      await expect.poll(() => run.output().includes(JSON.stringify({ echo: text })), { timeout: 5000 }).toBe(true);
      const closed = once(run.child, 'close');
      run.child.stdin.write('exit\n');
      await closed; await confirmAgentProcessExit(run.child);
      expect(agentProcessQuiescent(run.child)).toBe(true);
      expect(alive(run.pids.child)).toBe(false); expect(alive(run.pids.grandchild)).toBe(false);
    } finally { if (run.child.exitCode === null) run.child.kill('SIGKILL'); }
  }, 20_000);

  it('gracefully closes input then forces an EOF-ignoring tree without touching another process', async () => {
    const unrelated = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { windowsHide: true, stdio: 'ignore' });
    let run: Awaited<ReturnType<typeof start>> | undefined;
    try {
      run = await start('ignore-eof');
      const closed = once(run.child, 'close');
      run.child.kill('SIGTERM'); run.child.kill('SIGTERM');
      await closed; await confirmAgentProcessExit(run.child);
      expect(alive(run.pids.child)).toBe(false); expect(alive(run.pids.grandchild)).toBe(false);
      expect(alive(unrelated.pid!)).toBe(true);
    } finally { unrelated.kill(); if (run?.child.exitCode === null) { run.child.kill('SIGKILL'); await confirmAgentProcessExit(run.child).catch(() => {}); } }
  }, 20_000);

  it('kills nested descendants when its exact supervisor dies, retaining uncertain proof', async () => {
    const run = await start('ignore-eof');
    const closed = once(run.child, 'close');
    process.kill(run.child.pid!, 'SIGKILL');
    await closed;
    await expect(confirmAgentProcessExit(run.child)).rejects.toThrow('uncertain');
    await expect.poll(() => alive(run.pids.child) || alive(run.pids.grandchild)).toBe(false);
    expect(agentProcessQuiescent(run.child)).toBe(false);
  }, 20_000);
});
