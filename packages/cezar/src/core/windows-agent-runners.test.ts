import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ClaudeCliRunner } from './claude-cli-runner.ts';
import { CodexAppServerRunner } from './codex-app-server-runner.ts';
import type { AgentEvent } from './agent-runner.ts';

describe.skipIf(process.platform !== 'win32')('real runner Windows timeout supervision with disposable binaries', () => {
  const bin = fileURLToPath(new URL('./__fixtures__/supervised-process.mjs', import.meta.url));
  it.each(['claude', 'codex'] as const)('enforces a wall-clock timeout while %s ignores its protocol', async backend => {
    // This fixture spawns nested disposable Node children and never answers the provider protocol.
    const events: AgentEvent[] = [];
    const runner = backend === 'claude' ? new ClaudeCliRunner({ bin, timeoutMs: 2000 }) : new CodexAppServerRunner({ bin, timeoutMs: 2000 });
    const session = runner.startSession({ cwd: process.cwd(), userPrompt: 'disposable timeout fixture' }, event => events.push(event));
    const started = Date.now();
    await session.result;
    expect(Date.now() - started).toBeLessThan(12_000);
    expect(session.processQuiescent).toBe(true);
    expect(events.some(event => event.type === 'error' && event.message.includes('timed out'))).toBe(true);
  }, 20_000);
});
