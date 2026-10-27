import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isAbsolute, join } from 'node:path';
import { statSync } from 'node:fs';
import { resolveClaudeBin } from './claude-bin.ts';

/** No passthrough, provider overrides, API keys, helper settings, or cloud billing. */
export function realQueueEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const keep = new Set(['SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATH', 'PATHEXT', 'TEMP', 'TMP',
    'USERPROFILE', 'HOME', 'APPDATA', 'LOCALAPPDATA', 'HOMEDRIVE', 'HOMEPATH']);
  return { ...Object.fromEntries(Object.entries(source).filter(([key]) => keep.has(key.toUpperCase()))),
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' };
}

export function realQueueClaudeBin(): string {
  const env = realQueueEnv();
  let bin = resolveClaudeBin(env);
  if (bin === 'claude') {
    bin = (env.PATH ?? env.Path ?? '').split(';').filter(isAbsolute).map(dir => join(dir, 'claude.exe'))
      .find(path => { try { return statSync(path).isFile(); } catch { return false; } }) ?? bin;
  }
  if (!isAbsolute(bin) || !bin.toLowerCase().endsWith('.exe')) throw new Error('Guarded queue requires an installed native Claude executable at its discovered absolute path');
  return bin;
}

export async function assertClaudeProAuthentication(): Promise<void> {
  const exec = promisify(execFile);
  const bin = realQueueClaudeBin();
  const options = { env: realQueueEnv(), timeout: 10_000, maxBuffer: 65_536, windowsHide: true };
  const help = await exec(bin, ['--help'], options);
  if (!help.stdout.includes('--restricted') || !help.stdout.includes('--safe-mode')) throw new Error('Installed Claude lacks the required restricted and safe modes');
  const { stdout } = await exec(bin, ['--safe-mode', '--setting-sources', '', '--settings', '{"apiKeyHelper":""}', 'auth', 'status', '--json'], options);
  const status = JSON.parse(stdout) as Record<string, unknown>;
  if (status.loggedIn !== true || status.authMethod !== 'claude.ai' || status.apiProvider !== 'firstParty' || status.subscriptionType !== 'pro') {
    throw new Error('Guarded queue requires existing Claude Pro subscription authentication; API billing is forbidden');
  }
}
