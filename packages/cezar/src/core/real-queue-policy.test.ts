import { afterEach, describe, expect, it, vi } from 'vitest';
import { realQueueEnv } from './real-queue-policy.ts';
import { ClaudeCliRunner } from './claude-cli-runner.ts';
import { spawnAgentProcess } from './supervised-agent-process.ts';
import { createRealQueueRunner } from './runner-factory.ts';

vi.mock('./supervised-agent-process.ts', () => ({
  spawnAgentProcess: vi.fn(() => { throw new Error('test intercepted process creation'); }),
  confirmAgentProcessExit: vi.fn(), agentProcessQuiescent: vi.fn(),
}));
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

describe('real Claude launch policy without spawning a provider', () => {
  it('drops billing credentials, overrides, hooks and passthrough even when requested', () => {
    expect(realQueueEnv({ Path: 'safe-path', SystemRoot: 'windows', USERPROFILE: 'owner',
      ANTHROPIC_API_KEY: 'never-forward', ANTHROPIC_AUTH_TOKEN: 'never-forward',
      CLAUDE_CODE_OAUTH_TOKEN: 'never-forward', CLAUDE_CODE_USE_BEDROCK: '1',
      GH_TOKEN: 'never-forward', NODE_OPTIONS: '--require bad', CEZ_AGENT_ENV_FULL: '1',
      CEZ_ENV_PASSTHROUGH: 'ANTHROPIC_API_KEY', CEZ_CLAUDE_BIN: 'untrusted',
    })).toEqual({ Path: 'safe-path', SystemRoot: 'windows', USERPROFILE: 'owner', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' });
  });
  it('enforces restricted scoped tools, no settings/MCP, Pro environment, fixed model and turns at the spawn boundary', () => {
    vi.stubEnv('CEZ_QUEUE_REAL', '1'); vi.stubEnv('CEZ_DRY_RUN', '0');
    vi.stubEnv('CEZ_APPROVAL_GATE', '1'); vi.stubEnv('ANTHROPIC_API_KEY', 'forbidden');
    const runner = new ClaudeCliRunner({ bin: 'C:\\fixture\\claude.exe', guardedQueue: true });
    expect(() => runner.startSession({ cwd: 'C:\\fixture', userPrompt: 'task', allowedTools: ['Bash'],
      additionalDirectories: ['C:\\'], env: { ANTHROPIC_API_KEY: 'forbidden' }, model: 'other', timeoutMs: 0,
    })).toThrow('test intercepted');
    const [file, args, options] = vi.mocked(spawnAgentProcess).mock.calls[0]!;
    expect(file).toBe('C:\\fixture\\claude.exe');
    expect(args).toEqual(expect.arrayContaining(['--restricted', '--safe-mode', '--strict-mcp-config', '--tools', 'Read,Edit,Write',
      '--permission-mode', 'dontAsk', '--model', 'sonnet', '--max-turns', '8']));
    expect(args).not.toContain('--add-dir');
    expect(args).not.toContain('Bash');
    expect(args[args.indexOf('--allowedTools') + 1]).toBe('Read(./sum.mjs),Edit(./sum.mjs),Write(./sum.mjs)');
    expect(args[args.indexOf('--setting-sources') + 1]).toBe('');
    expect(args[args.indexOf('--mcp-config') + 1]).toBe('{"mcpServers":{}}');
    expect(options.env).not.toHaveProperty('ANTHROPIC_API_KEY');
  });
  it('cannot select a real backend by default, in dry-run, or with Codex', () => {
    vi.stubEnv('CEZ_QUEUE_REAL', '0');
    expect(() => createRealQueueRunner('claude')).toThrow('explicit');
    vi.stubEnv('CEZ_QUEUE_REAL', '1'); vi.stubEnv('CEZ_DRY_RUN', '1');
    expect(() => createRealQueueRunner('claude')).toThrow('explicit');
    vi.stubEnv('CEZ_DRY_RUN', '0');
    expect(() => createRealQueueRunner('codex')).toThrow('explicit');
    expect(spawnAgentProcess).not.toHaveBeenCalled();
  });
});
