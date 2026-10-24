import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runRoadmapCommand } from './cli.ts';
import { githubIssuesFromForge, planRoadmap, roadmapInputSchema } from './planner.ts';

const fixture = {
  allowedRepositories: [{ repo: 'fictional/atlas' }, { repo: 'fictional/beacon' }],
  githubIssues: [
    { repo: 'fictional/atlas', number: 1, title: 'Search', url: 'https://github.com/fictional/atlas/issues/1', state: 'open', labels: ['roadmap-approved', 'priority:p2'] },
    { repo: 'fictional/other', number: 9, title: 'Outside', url: 'https://github.com/fictional/other/issues/9', state: 'open', labels: ['roadmap-approved', 'priority:p1'] },
    { repo: 'fictional/atlas', number: 2, title: 'Closed', url: 'https://github.com/fictional/atlas/issues/2', state: 'closed', labels: ['roadmap-approved', 'priority:p1'] },
  ],
  roadmaps: [
    { id: 'index', repo: 'fictional/atlas', title: 'Index', priority: 1, approval: 'approved', dependencies: [], blockers: [], preferredRunner: 'codex' },
    { id: 'dependent', repo: 'fictional/beacon', title: 'Dependent', priority: 2, approval: 'approved', dependencies: ['schema'], blockers: [] },
    { id: 'linked', repo: 'fictional/atlas', title: 'Linked closed issue', githubIssue: 2, priority: 1, approval: 'approved', dependencies: [], blockers: [] },
  ],
  runningTaskIds: ['fictional/atlas#1'], completedTaskIds: [],
};

describe('planning-only roadmap queue', () => {
  let home: string | undefined;
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    if (home) rmSync(home, { recursive: true, force: true });
    home = undefined;
  });

  it('ranks approved work and explains blocked, duplicate, completed, running, and disallowed candidates', () => {
    const preview = planRoadmap(roadmapInputSchema.parse(fixture), new Date('2026-10-24T12:00:00Z'));
    expect(preview.rows[0]).toMatchObject({ id: 'index', status: 'ready', preferredRunner: 'codex', executionEligible: false });
    expect(preview.rows.find((row) => row.id === 'dependent')?.reason).toContain('unmet dependencies');
    expect(preview.rows.find((row) => row.id === 'fictional/atlas#1')?.reason).toContain('already running');
    expect(preview.rows.find((row) => row.id === 'fictional/other#9')?.reason).toContain('allowlist');
    expect(preview.rows.filter((row) => row.id === 'fictional/atlas#2')).toHaveLength(2);
    expect(preview.rows.filter((row) => row.id === 'fictional/atlas#2').every((row) => row.status === 'excluded')).toBe(true);
    expect(preview.rows.every((row) => row.executionEligible === false)).toBe(true);
  });

  it('converts normalized forge issues and ignores pull requests', () => {
    const issues = githubIssuesFromForge('fictional/atlas', [
      { kind: 'issue', number: 1, title: 'Search', author: 'dev', createdAt: '2026-10-24', labels: ['roadmap-approved'], url: 'https://github.com/fictional/atlas/issues/1', comments: 0 },
      { kind: 'pr', number: 2, title: 'PR', author: 'dev', createdAt: '2026-10-24', labels: [], url: 'https://github.com/fictional/atlas/pull/2', comments: 0 },
    ]);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.number).toBe(1);
  });

  it('writes a durable preview while never invoking a provider or starting a run', async () => {
    home = mkdtempSync(join(tmpdir(), 'cez-roadmap-'));
    vi.stubEnv('CEZ_HOME', home);
    const inputPath = join(home, 'input.json');
    writeFileSync(inputPath, JSON.stringify(fixture));
    const print = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(await runRoadmapCommand(['preview', '--input', inputPath])).toBe(0);
    const saved = JSON.parse(readFileSync(join(home, 'roadmap', 'preview.json'), 'utf8'));
    expect(saved.mode).toBe('planning-only');
    expect(saved.rows.every((row: { executionEligible: boolean }) => row.executionEligible === false)).toBe(true);
    expect(print.mock.calls.some(([line]) => String(line).includes('execution eligibility: none'))).toBe(true);
  });
});
