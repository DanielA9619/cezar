import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { WorkflowDef } from '../workflows/types.ts';

export const REAL_QUEUE_WORKFLOW = 'queue-claude-pro-verify';
export const REAL_QUEUE_SCOPE = 'sum.mjs';
export const REAL_QUEUE_VERIFY = 'cezar:sum-verify';
export const REAL_QUEUE_AGENT_MS = 180_000;
export const REAL_QUEUE_TOTAL_MS = 420_000;
export const REAL_QUEUE_TASK = 'Implement sum(a, b) in sum.mjs: return the sum of two finite numbers; throw TypeError for non-number or non-finite arguments. Change only sum.mjs. Do not install dependencies, use shell commands, dispatch other agents, or access GitHub. Cezar runs the fixed tests. End with CEZ:DONE.';

export function queueRealWorkflow(maxAttempts: number): WorkflowDef {
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 2) throw new Error('Real queue permits one or two attempts');
  const script = join(dirname(fileURLToPath(import.meta.url)), '../../scripts/queue-sum-verify.mjs');
  return {
    name: REAL_QUEUE_WORKFLOW, source: 'built-in', requiresReview: true,
    description: `Claude Pro only; sonnet; restricted safe mode; 8 turns; ${REAL_QUEUE_AGENT_MS}ms per attempt; ${REAL_QUEUE_TOTAL_MS}ms total; scope ${REAL_QUEUE_SCOPE}; verifier sha256 ${createHash('sha256').update(readFileSync(script)).digest('hex')}`,
    steps: [
      { id: 'implement', name: 'Implement finite-number sum', runner: 'claude', prompt: REAL_QUEUE_TASK,
        allowedTools: ['Read(./sum.mjs)', 'Edit(./sum.mjs)', 'Write(./sum.mjs)'] },
      { id: 'verify', name: 'Fixed sum verification', command: `"${process.execPath}" "${script}"`, timeoutSeconds: 15,
        ...(maxAttempts > 1 ? { onFail: { retry: 'implement', max: maxAttempts - 1, retryOn: [1] } } : {}) },
    ],
  };
}

export function queueRealWorkflowRevision(maxAttempts: number): string {
  return createHash('sha256').update(JSON.stringify(queueRealWorkflow(maxAttempts))).digest('hex');
}
