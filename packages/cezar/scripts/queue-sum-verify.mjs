import assert from 'node:assert/strict';
import { readFileSync, lstatSync } from 'node:fs';
import { resolve } from 'node:path';
import { Script, createContext } from 'node:vm';

// Evaluate only the one approved pure function, without Node, imports or filesystem access.
const path = resolve('sum.mjs');
assert(lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink(), 'sum.mjs must be a regular file');
const source = readFileSync(path, 'utf8');
assert(source.length <= 8192, 'Implementation exceeds scope bound');
assert(/^\s*export\s+function\s+sum\s*\(/.test(source), 'Export function sum(a, b)');
const context = createContext({}, { codeGeneration: { strings: false, wasm: false } });
new Script(source.replace(/^\s*export\s+/, '')).runInContext(context, { timeout: 1000 });
for (const [a, b, expected] of [[2, 3, 5], [-2, 3, 1], [0, 0, 0], [0.5, 1.25, 1.75], [-3, -4, -7]]) {
  assert.equal(new Script(`sum(${a}, ${b})`).runInContext(context, { timeout: 1000 }), expected);
}
for (const expression of ['sum("2", 3)', 'sum(2, null)', 'sum(NaN, 1)', 'sum(1, Infinity)', 'sum(undefined, 1)', 'sum(1, -Infinity)']) {
  assert.equal(new Script(`(() => { try { ${expression}; return false; } catch(e) { return e instanceof TypeError; } })()`).runInContext(context, { timeout: 1000 }), true, expression);
}
console.log('PASS: fixed finite-number sum tests');
