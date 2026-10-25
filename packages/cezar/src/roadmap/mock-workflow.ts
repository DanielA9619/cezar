import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { WorkflowDef } from '../workflows/types.ts';

export function queueMockWorkflow(agent: 'claude' | 'codex', maxAttempts: number): WorkflowDef {
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 3) throw new Error('Mock queue attempts must be between 1 and 3');
  const script = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'mock-queue-verify.mjs');
  const command = `"${process.execPath}" "${script}"`;
  return {
    name: 'queue-mock-verify', source: 'built-in', requiresReview: true,
    description: 'Bundled mock implementation, correction, and fixed verification only',
    steps: [
      { id: 'implement', name: 'Mock implementation', runner: agent, prompt: 'mock:done {{task}}' },
      { id: 'verify', name: 'Fixed mock verification', command,
        ...(maxAttempts > 1 ? { onFail: { retry: 'implement', max: maxAttempts - 1, retryOn: [1] } } : {}) },
    ],
  };
}

export function queueMockWorkflowRevision(agent: 'claude' | 'codex', maxAttempts: number): string {
  return createHash('sha256').update(JSON.stringify(queueMockWorkflow(agent, maxAttempts))).digest('hex');
}
