import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GithubData } from '../server/forge/github.ts';
import { roadmapInputSchema } from './planner.ts';
import { refreshQueueGithub, type GithubQueueSource } from './github-source.ts';
import { ownerAuthorization, queuePreview, readQueueState, reservePlanningTask, saveQueueInput, setPriority, updateQueue } from './queue.ts';

const issue = (repo: string, number: number, title = `Issue ${number}`) => ({ repo, number, title, url: `https://github.com/${repo}/issues/${number}`, state: 'open' as const, labels: ['roadmap-approved'] });
const fixture = roadmapInputSchema.parse({
  allowedRepositories: [{ repo: 'fictional/atlas', projectId: 'atlas' }, { repo: 'fictional/beacon', projectId: 'beacon' }],
  githubIssues: [issue('fictional/atlas', 1)],
  roadmaps: [
    { id: 'atlas-schema', repo: 'fictional/atlas', title: 'Schema', priority: 2, approval: 'approved', preferredRunner: 'codex', dependencies: [], blockers: [] },
    { id: 'beacon-client', repo: 'fictional/beacon', title: 'Client', priority: 1, approval: 'approved', dependencies: ['atlas-schema'], blockers: [] },
    { id: 'beacon-ui', repo: 'fictional/beacon', title: 'UI', priority: 3, approval: 'approved', dependencies: [], blockers: [] },
  ],
});

describe('persistent planning-only work queue', () => {
  let home: string;
  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'cez-queue-'));
    vi.stubEnv('CEZ_HOME', home);
    await saveQueueInput(fixture);
  });
  afterEach(() => { vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }); });

  it('ranks across projects, blocks dependencies, and survives restart with priority edits', async () => {
    let view = queuePreview(await readQueueState());
    expect(view.nextTaskId).toBe('atlas-schema');
    expect(view.rows.find((row) => row.id === 'beacon-client')?.status).toBe('blocked');
    expect(view.rows.find((row) => row.id === 'fictional/atlas#1')?.status).toBe('stale');
    view = await setPriority('beacon-ui', 1);
    expect(view.nextTaskId).toBe('beacon-ui');
    expect(queuePreview(await readQueueState()).rows.find((row) => row.id === 'beacon-ui')?.priority).toBe(1);
    expect((await readQueueState()).decisions.at(-1)).toMatchObject({ nextTaskId: 'beacon-ui', considered: 4 });
    expect(view.rows.every((row) => row.executionEligible === false)).toBe(true);
  });

  it('serializes competing planning reservations across instances', async () => {
    const claims = await Promise.all(Array.from({ length: 4 }, (_, index) => reservePlanningTask('atlas-schema', `planner-${index}`)));
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(queuePreview(await readQueueState()).rows.find((row) => row.id === 'atlas-schema')?.status).toBe('active');
    expect(await reservePlanningTask('atlas-schema', 'late')).toBe(false);
  });

  it('requires owner channel, records edits and revocation, and expires independently of ranking', async () => {
    const auth = { taskId: 'atlas-schema', repo: 'fictional/atlas', scope: 'src/schema.ts only', agent: 'codex' as const, workflow: 'reliable-npm-task', expiresAt: '2030-01-01T00:00:00.000Z', maxAttempts: 2, requireReview: true as const, verificationCommand: 'npm test' };
    await expect(ownerAuthorization(auth, 'grant', false)).rejects.toThrow('trusted');
    expect((await ownerAuthorization(auth, 'grant', true)).audit[0]?.action).toBe('created');
    expect(queuePreview(await readQueueState(), new Date('2027-01-01')).rows.find((row) => row.id === 'atlas-schema')?.authorization).toBe('active');
    expect(queuePreview(await readQueueState(), new Date('2031-01-01')).rows.find((row) => row.id === 'atlas-schema')?.authorization).toBe('expired');
    expect((await ownerAuthorization({ ...auth, maxAttempts: 1 }, 'grant', true)).audit.map((entry) => entry.action)).toEqual(['created', 'modified']);
    expect((await ownerAuthorization(auth, 'revoke', true)).audit.at(-1)?.action).toBe('revoked');
    expect(queuePreview(await readQueueState()).rows.find((row) => row.id === 'atlas-schema')?.authorization).toBe('revoked');
  });

  it('refreshes multiple GitHub pages by repository and issue number, and fails closed on partial data', async () => {
    const atlas = join(home, 'atlas'); const beacon = join(home, 'beacon');
    mkdirSync(atlas); mkdirSync(beacon);
    writeFileSync(join(home, 'config.json'), JSON.stringify({ projects: [
      { id: 'atlas', root: atlas, name: 'Atlas', addedAt: '', lastOpenedAt: '', source: 'local' },
      { id: 'beacon', root: beacon, name: 'Beacon', addedAt: '', lastOpenedAt: '', source: 'local' },
    ] }));
    const item = (number: number, title: string) => ({ kind: 'issue' as const, number, title, author: 'dev', createdAt: '2026-10-24', labels: ['roadmap-approved'], url: `https://github.com/fictional/atlas/issues/${number}`, comments: 0 });
    const calls: string[] = [];
    const source: GithubQueueSource = {
      page: async (root, _refresh, _limit, cursors) => {
        calls.push(`${root}:${cursors.issuesCursor ?? 'first'}`);
        const data: GithubData = root === atlas
          ? cursors.issuesCursor ? { available: true, repo: 'fictional/atlas', issues: [item(2, 'Second')], prs: [], issuesTotal: 2, issuesNextCursor: null }
            : { available: true, repo: 'fictional/atlas', issues: [item(1, 'Renamed')], prs: [], issuesTotal: 2, issuesNextCursor: 'next' }
          : { available: true, repo: 'fictional/beacon', issues: [], prs: [], issuesTotal: 0, issuesNextCursor: null };
        return data;
      },
      status: async () => ({ available: true, prs: {}, issues: {}, recheckAfterMs: null }),
    };
    await refreshQueueGithub(source);
    expect(calls).toHaveLength(3);
    let view = queuePreview(await readQueueState());
    expect(view.rows.filter((row) => row.id === 'fictional/atlas#1')).toHaveLength(1);
    expect(view.rows.find((row) => row.id === 'fictional/atlas#1')?.title).toBe('Renamed');
    expect(view.rows.find((row) => row.id === 'fictional/atlas#2')?.status).toBe('ready');
    await refreshQueueGithub({ ...source, page: async (root) => root === atlas
      ? { available: true, repo: 'fictional/atlas', issues: [item(2, 'Second')], prs: [], issuesTotal: 1, issuesNextCursor: null }
      : { available: true, repo: 'fictional/beacon', issues: [], prs: [], issuesTotal: 0, issuesNextCursor: null },
      status: async () => ({ available: true, prs: {}, issues: { 1: 'completed' }, recheckAfterMs: null }),
    });
    view = queuePreview(await readQueueState());
    expect(view.rows.find((row) => row.id === 'fictional/atlas#1')?.status).toBe('completed');
    await refreshQueueGithub({ ...source, page: async (root) => root === atlas
      ? { available: true, repo: 'fictional/atlas', issues: [item(2, 'Second')], prs: [], issuesTotal: 4, issuesNextCursor: null }
      : { available: true, repo: 'fictional/beacon', issues: [], prs: [], issuesTotal: 0, issuesNextCursor: null },
    });
    view = queuePreview(await readQueueState());
    expect(view.rows.find((row) => row.id === 'fictional/atlas#2')?.status).toBe('stale');
    expect(view.rows.find((row) => row.id === 'fictional/atlas#2')?.reason).toContain('incomplete');
    await refreshQueueGithub({ ...source, page: async () => ({ available: false, reason: 'rate limited', issues: [], prs: [] }) });
    view = queuePreview(await readQueueState());
    expect(view.rows.find((row) => row.id === 'fictional/atlas#1')?.status).toBe('stale');
    expect(view.rows.find((row) => row.id === 'fictional/atlas#1')?.reason).toContain('rate limited');
    expect(view.rows.every((row) => row.executionEligible === false)).toBe(true);
    await updateQueue((state) => { state.input.completedTaskIds.push('fictional/atlas#2'); });
    expect(queuePreview(await readQueueState()).rows.find((row) => row.id === 'fictional/atlas#2')?.status).toBe('stale');
  });
});
