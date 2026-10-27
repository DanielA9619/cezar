import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

export const realFixtureFiles: Record<string, string> = {
  '.cezar-disposable': 'cezar-milestone-1c2-disposable-sum-v1\n',
  '.gitignore': '.ai/\n',
  'README.md': 'Disposable Cezar task: implement sum(a, b) for finite numbers in sum.mjs. Invalid inputs throw TypeError. Only sum.mjs may change. Verification is supplied by Cezar.\n',
  'sum.mjs': 'export function sum(a, b) {\n  throw new Error("Not implemented");\n}\n',
};

/** A marker alone cannot turn an arbitrary repository into the approved first fixture. */
export async function assertRealFixture(root: string, worktree = false): Promise<void> {
  const exec = promisify(execFile);
  const git = async (...args: string[]) => (await exec('git', ['-C', root, ...args], { timeout: 10_000, maxBuffer: 64_000, windowsHide: true })).stdout.trim();
  if (await git('remote')) throw new Error('Real fixture must have no Git remotes');
  const tracked = (await git('ls-files')).split(/\r?\n/).sort();
  if (JSON.stringify(tracked) !== JSON.stringify(Object.keys(realFixtureFiles).sort())) throw new Error('Real fixture tracked files differ from the approved template');
  for (const [name, content] of Object.entries(realFixtureFiles)) {
    const info = await lstat(join(root, name));
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Real fixture has unsafe file: ${name}`);
    if ((!worktree || name !== 'sum.mjs') && await readFile(join(root, name), 'utf8') !== content) throw new Error(`Real fixture content changed outside scope: ${name}`);
  }
  for (const name of await readdir(root)) {
    if (!(name in realFixtureFiles) && name !== '.git' && name !== '.ai') throw new Error(`Real fixture contains unapproved path: ${name}`);
  }
  if (!worktree) {
    const config = JSON.parse(await readFile(join(root, '.ai/cezar/config.json'), 'utf8')) as Record<string, unknown>;
    if (JSON.stringify(config) !== JSON.stringify({ reviewGate: true })) throw new Error('Real fixture requires the fixed review-only project configuration');
    const hooks = await git('rev-parse', '--git-path', 'hooks');
    const hookNames = await readdir(join(root, hooks)).catch(() => [] as string[]);
    if (hookNames.some(name => !name.endsWith('.sample'))) throw new Error('Real fixture must have no executable Git hooks');
    const customHooks = await git('config', '--get', 'core.hooksPath').catch(() => '');
    if (customHooks) throw new Error('Real fixture must not use custom Git hooks');
  }
}
