import type { AgentBackend, AgentRunner, RunnerId } from './agent-runner.ts';
import { ClaudeCliRunner } from './claude-cli-runner.ts';
import { CodexAppServerRunner } from './codex-app-server-runner.ts';
import { JunieRunner } from './junie-runner.ts';
import { CopilotAcpRunner } from './copilot-acp-runner.ts';
import { OpencodeServerRunner } from './opencode-server-runner.ts';
import { CursorAgentRunner } from './cursor-agent-runner.ts';
import { PiRunner } from './pi-runner.ts';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The single place that maps a backend id onto a concrete runner. Everything
 * that used to `new ClaudeCliRunner()` (the planner and the workflow engine)
 * goes through here so switching the agent backend is one function call.
 * `claude-cli` is the legacy id for `claude`.
 */
export function createRunner(backend: AgentBackend | RunnerId | undefined): AgentRunner {
  switch (backend) {
    case 'codex':
      return new CodexAppServerRunner();
    case 'opencode':
      return new OpencodeServerRunner();
    case 'cursor':
      return new CursorAgentRunner();
    case 'pi':
      return new PiRunner();
    case 'junie':
      return new JunieRunner();
    case 'copilot':
      return new CopilotAcpRunner();
    case 'claude':
    case 'claude-cli':
    default:
      return new ClaudeCliRunner();
  }
}

/** Milestone 1C never consults provider configuration, PATH, or CEZ_DRY_RUN for queue launches. */
export function createMockQueueRunner(backend: RunnerId): AgentRunner {
  const script = backend === 'codex' ? 'mock-codex-app-server.mjs' : backend === 'claude' ? 'mock-queue-claude.mjs' : undefined;
  if (!script) throw new Error('Queue bridge permits only the bundled Claude and Codex mocks');
  const bin = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', script);
  return backend === 'codex' ? new CodexAppServerRunner({ bin }) : new ClaudeCliRunner({ bin });
}
