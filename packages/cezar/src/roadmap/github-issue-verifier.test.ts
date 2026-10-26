import { describe, expect, it } from 'vitest';
import { freshGithubSnapshot, parseGithubIssueEvidence, sameGithubSnapshot } from './github-issue-verifier.ts';

const repo = { id: 42, node_id: 'R_42', full_name: 'fictional/atlas', url: 'https://api.github.com/repos/fictional/atlas' };
const issue = { id: 117, node_id: 'I_117', number: 7, repository_url: repo.url,
  state: 'open', state_reason: null, updated_at: '2026-10-24T00:00:00Z', title: 'Fix mock', body: 'Original body',
  labels: [{ id: 1, name: 'roadmap-approved' }, { id: 2, name: 'priority:p1' }] };

describe('direct GitHub issue evidence', () => {
  it('binds stable IDs and the entire mutable issue snapshot, even within one updated_at second', () => {
    const first = parseGithubIssueEvidence('fictional/atlas', 7, repo, issue);
    expect(first.snapshot).toMatchObject({ repositoryId: 42, issueId: 117, issueNumber: 7 });
    expect(sameGithubSnapshot(first.snapshot, parseGithubIssueEvidence('fictional/atlas', 7, repo, issue).snapshot)).toBe(true);
    for (const changed of [{ ...issue, body: 'Edited body' }, { ...issue, labels: [{ id: 2, name: 'priority:p1' }] },
      { ...issue, state: 'closed' }, { ...issue, id: 118 }]) {
      expect(sameGithubSnapshot(first.snapshot, parseGithubIssueEvidence('fictional/atlas', 7, repo, changed).snapshot)).toBe(false);
    }
  });

  it('rejects repository redirects, issue number changes, PRs, and incomplete responses', () => {
    expect(() => parseGithubIssueEvidence('fictional/atlas', 7, { ...repo, full_name: 'other/atlas' }, issue)).toThrow('repository identity');
    expect(() => parseGithubIssueEvidence('fictional/atlas', 7, repo, { ...issue, number: 8 })).toThrow('issue identity');
    expect(() => parseGithubIssueEvidence('fictional/atlas', 7, repo, { ...issue, pull_request: {} })).toThrow('issue identity');
    expect(() => parseGithubIssueEvidence('fictional/atlas', 7, repo, { ...issue, updated_at: undefined })).toThrow();
  });
  it('rejects stale or future direct reads before launch', () => {
    const snapshot = parseGithubIssueEvidence('fictional/atlas', 7, repo, issue, '2026-10-24T00:00:00.000Z').snapshot;
    const now = Date.parse('2026-10-24T00:00:20.000Z');
    expect(freshGithubSnapshot(snapshot, now)).toBe(true);
    expect(freshGithubSnapshot(snapshot, now + 30_001)).toBe(false);
    expect(freshGithubSnapshot(snapshot, now - 21_000)).toBe(false);
  });
});
