import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import { parseRemote } from '../git-remotes.ts';
import { isGithubHost } from '../github-hosts.ts';
import { getRepoInfo } from '../server/git.ts';
import type { QueueAuthorization } from '@open-mercato/cezar-contract';

type Snapshot = NonNullable<QueueAuthorization['githubSnapshot']>;
const exec = promisify(execFile);
const repositorySchema = z.object({ id: z.number().int().positive(), node_id: z.string().min(1),
  full_name: z.string().min(1), url: z.string().url() });
const issueSchema = z.object({ id: z.number().int().positive(), node_id: z.string().min(1),
  number: z.number().int().positive(), repository_url: z.string().url(), state: z.enum(['open', 'closed']),
  state_reason: z.string().nullable().optional(), updated_at: z.string().datetime(),
  title: z.string(), body: z.string().nullable(),
  labels: z.array(z.object({ id: z.number().int().positive(), name: z.string() })),
  pull_request: z.unknown().optional() });

export interface GithubIssueEvidence { snapshot: Snapshot; state: 'open' | 'closed'; title: string; labels: string[] }
export type GithubIssueReader = (root: string, repo: string, number: number) => Promise<GithubIssueEvidence>;
export function freshGithubSnapshot(snapshot: Snapshot, now = Date.now()): boolean {
  const verified = Date.parse(snapshot.verifiedAt);
  return Number.isFinite(verified) && verified <= now && now - verified <= 30_000;
}

export function parseGithubIssueEvidence(repo: string, number: number, rawRepository: unknown, rawIssue: unknown,
  verifiedAt = new Date().toISOString()): GithubIssueEvidence {
  const repository = repositorySchema.parse(rawRepository);
  if (repository.full_name.toLowerCase() !== repo.toLowerCase()) throw new Error('GitHub repository identity changed');
  const issue = issueSchema.parse(rawIssue);
  if (issue.number !== number || issue.repository_url !== repository.url || issue.pull_request !== undefined) {
    throw new Error('GitHub issue identity does not match the selected task');
  }
  const labels = [...issue.labels].sort((a, b) => a.id - b.id);
  const digest = createHash('sha256').update(JSON.stringify({ repositoryId: repository.id,
    issueId: issue.id, issueNodeId: issue.node_id, number: issue.number, state: issue.state,
    stateReason: issue.state_reason ?? null, updatedAt: issue.updated_at,
    title: issue.title, body: issue.body, labels })).digest('hex');
  return { state: issue.state, title: issue.title, labels: labels.map((label) => label.name),
    snapshot: { repositoryId: repository.id, repositoryNodeId: repository.node_id,
      issueId: issue.id, issueNodeId: issue.node_id, issueNumber: issue.number,
      updatedAt: issue.updated_at, digest, verifiedAt } };
}

/** Two bounded single-resource reads. No list pagination or cache can authorize a launch. */
export const readGithubIssue: GithubIssueReader = async (root, repo, number) => {
  const remote = parseRemote((await getRepoInfo(root))?.remote ?? '');
  if (!remote || !isGithubHost(remote.host) || `${remote.owner}/${remote.repo}`.toLowerCase() !== repo.toLowerCase()) {
    throw new Error('Project GitHub remote does not match the allowlisted repository');
  }
  const read = async (path: string): Promise<unknown> => {
    try {
      const { stdout } = await exec('gh', ['api', '--hostname', remote.host, path], {
        cwd: root, timeout: 10_000, maxBuffer: 2 * 1024 * 1024,
        env: { ...process.env, GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0' },
      });
      return JSON.parse(stdout);
    } catch { throw new Error('Direct GitHub issue verification failed (unavailable, inaccessible, or rate limited)'); }
  };
  const repository = await read(`repos/${remote.owner}/${remote.repo}`);
  const issue = await read(`repos/${remote.owner}/${remote.repo}/issues/${number}`);
  return parseGithubIssueEvidence(repo, number, repository, issue);
};

export function sameGithubSnapshot(a: Snapshot, b: Snapshot): boolean {
  return a.repositoryId === b.repositoryId && a.repositoryNodeId === b.repositoryNodeId &&
    a.issueId === b.issueId && a.issueNodeId === b.issueNodeId && a.issueNumber === b.issueNumber &&
    a.updatedAt === b.updatedAt && a.digest === b.digest;
}
