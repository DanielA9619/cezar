import { join } from 'node:path';
import { fetchGithub, fetchGithubRefStatus, type GithubData, type GithubRefStatusData } from '../server/forge/github.ts';
import { loadWorkspaceConfig } from '../workspace/config.ts';
import { readRunIndexDiagnostic } from '../runs/run-index.ts';
import { githubIssuesFromForge } from './planner.ts';
import { readQueueState, updateQueue } from './queue.ts';

export interface GithubQueueSource {
  page(root: string, refresh: boolean, limit: number, cursors: { issuesCursor?: string; prsCursor?: string }): Promise<GithubData>;
  status(root: string, input: { issues: number[] }): Promise<GithubRefStatusData>;
}
const liveSource: GithubQueueSource = { page: fetchGithub, status: fetchGithubRefStatus };

/** Explicit refresh only. A failed or partial source invalidates eligibility without erasing the last known issues. */
export async function refreshQueueGithub(source: GithubQueueSource = liveSource): Promise<void> {
  const before = await readQueueState();
  const workspace = await loadWorkspaceConfig();
  for (const allowed of before.input.allowedRepositories) {
    const repo = allowed.repo.toLowerCase();
    const project = workspace.projects.find((entry) => entry.id === allowed.projectId);
    let reason: string | undefined;
    let issues: typeof before.input.githubIssues = [];
    let verifiedAt: string | undefined;
    if (!project) reason = 'Allowlisted repository has no registered project';
    else {
      try {
        let cursor: string | undefined;
        const seenCursors = new Set<string>();
        let total: number | undefined;
        for (let pageNumber = 0; pageNumber < 20; pageNumber++) {
          const page = await source.page(project.root, true, 100, cursor ? { issuesCursor: cursor } : {});
          if (!page.available || page.repo?.toLowerCase() !== repo) { reason = page.reason ?? 'Repository identity or authentication could not be verified'; break; }
          if (page.issuesTotal === undefined) { reason = 'GitHub response omitted issue count'; break; }
          total = page.issuesTotal;
          issues.push(...githubIssuesFromForge(allowed.repo, page.issues));
          const next = page.issuesNextCursor;
          if (next == null) break;
          if (!next || seenCursors.has(next)) { reason = 'GitHub pagination cursor was missing or repeated'; break; }
          seenCursors.add(next);
          cursor = next;
          if (pageNumber === 19) reason = 'GitHub issue pagination exceeded the 2000 issue safety cap';
        }
        if (!reason && (total === undefined || issues.length !== total || new Set(issues.map((item) => item.number)).size !== issues.length)) {
          reason = 'GitHub issue response is incomplete or duplicated';
        }
        if (!reason) {
          const oldNumbers = before.input.githubIssues.filter((item) => item.repo.toLowerCase() === repo).map((item) => item.number);
          const missing = [...new Set(oldNumbers)].filter((number) => !issues.some((item) => item.number === number));
          if (missing.length) {
            const statuses = await source.status(project.root, { issues: missing });
            if (!statuses.available || missing.some((number) => !statuses.issues[number])) reason = 'Previously known issue status could not be verified';
            else for (const number of missing) {
              const old = before.input.githubIssues.find((item) => item.repo.toLowerCase() === repo && item.number === number);
              const status = statuses.issues[number];
              if (status === 'open') { reason = 'GitHub open issue list omitted a still-open issue'; break; }
              if (old && (status === 'completed' || status === 'not-planned')) issues.push({ ...old, state: 'closed' });
              else { reason = 'Previously known issue identity is uncertain'; break; }
            }
          }
        }
        const runs = readRunIndexDiagnostic(join(project.root, '.ai', 'cezar'), project.root);
        if (runs.state !== 'complete') reason = runs.reason ?? 'Run state is unverified';
        if (!reason) {
          await updateQueue((state) => {
            if (!state.input.allowedRepositories.some((entry) => entry.repo.toLowerCase() === repo && entry.projectId === allowed.projectId)) throw new Error('Allowlist changed during refresh');
            state.input.githubIssues = [...state.input.githubIssues.filter((item) => item.repo.toLowerCase() !== repo), ...issues];
            state.input.runningTaskIds = state.input.runningTaskIds.filter((id) => !id.toLowerCase().startsWith(`${repo}#`));
            state.input.completedTaskIds = state.input.completedTaskIds.filter((id) => !id.toLowerCase().startsWith(`${repo}#`));
            for (const run of runs.runs) {
              if (!run.issueNumber) continue;
              const id = `${allowed.repo}#${run.issueNumber}`;
              if (['queued', 'running', 'waiting', 'review'].includes(run.status)) state.input.runningTaskIds.push(id);
              if (run.status === 'done') state.input.completedTaskIds.push(id);
            }
            verifiedAt = new Date().toISOString();
            state.sources[repo] = { verifiedAt, complete: true };
          });
        }
      } catch (error) { reason = error instanceof Error ? error.message : String(error); }
    }
    if (reason) await updateQueue((state) => { state.sources[repo] = { ...state.sources[repo], complete: false, reason: reason!.slice(0, 300) }; });
  }
}
