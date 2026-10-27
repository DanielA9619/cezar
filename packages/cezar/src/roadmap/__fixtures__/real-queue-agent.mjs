import { readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const initial = readFileSync('sum.mjs', 'utf8').includes('Not implemented');
writeFileSync('sum.mjs', initial ? 'export function sum(a, b) { return a - b; }\n' :
  'export function sum(a, b) { if (typeof a !== "number" || typeof b !== "number" || !Number.isFinite(a) || !Number.isFinite(b)) throw new TypeError("finite numbers required"); return a + b; }\n');
const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
emit({ type: 'system', subtype: 'init' });
const input = createInterface({ input: process.stdin });
input.on('line', () => {
  if (process.env.TEST_QUEUE_WAIT === '1') return;
  emit({ type: 'assistant', message: { content: [{ type: 'text', text: 'Fixture implementation complete.\nCEZ:DONE' }] } });
  emit({ type: 'result', subtype: 'success', result: 'CEZ:DONE', is_error: false, usage: { input_tokens: 1, output_tokens: 1 } });
});
input.on('close', () => process.exit(0));
