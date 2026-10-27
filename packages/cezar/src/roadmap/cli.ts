import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { cezarHomeDir, assertCezarHomeWriteIsSandboxed } from '../paths.ts';
import { renameWithRetry } from '../fs-rename.ts';
import { loadWorkspaceConfig } from '../workspace/config.ts';
import { fetchGithub } from '../server/forge/github.ts';
import { readRunIndexFromDisk } from '../runs/run-index.ts';
import { githubIssuesFromForge, planRoadmap, roadmapInputSchema } from './planner.ts';
import { queuePreview, readQueueState, saveQueueInput } from './queue.ts';
import { refreshQueueGithub } from './github-source.ts';
import { dispatchOneQueueTask } from './bridge.ts';

/** Explicit CLI only. No timer, server route, RunManager call, or agent spawn. */
export async function runRoadmapCommand(args: string[]): Promise<number> {
  if (args[0] === 'queue') {
    try {
      const command = args[1];
      const inputAt = args.indexOf('--input');
      const inputPath = inputAt >= 0 ? args[inputAt + 1] : undefined;
      if (command === 'load' && inputPath) {
        const raw = await readFile(resolve(inputPath), 'utf8');
        if (raw.length > 1_000_000) throw new Error('planning input exceeds 1 MB');
        await saveQueueInput(roadmapInputSchema.parse(JSON.parse(raw)));
      } else if (command === 'refresh' && args.length === 2) {
        await refreshQueueGithub();
      } else if (command === 'dispatch' && args.length <= 3) {
        const result = await dispatchOneQueueTask(args[2]);
        console.log(`Queue task ${result.taskId}: run ${result.runId} → ${result.status}`);
        return result.status === 'review' ? 0 : 1;
      } else if (command === 'authorize' || command === 'revoke') {
        throw new Error('Owner authorization requires Windows Hello in the local Roadmap queue cockpit; CLI input cannot approve or revoke execution');
      } else if (command !== 'show' || args.length !== 2) {
        throw new Error('Usage: cezar roadmap queue load --input <planning.json> | refresh | show | dispatch [task-id]');
      }
      const preview = queuePreview(await readQueueState());
      console.log(`Planning only — next: ${preview.nextTaskId ?? 'none'}; authorizations never start work`);
      for (const row of preview.rows) console.log(`${row.status.padEnd(9)} P${row.priority} ${row.id} (${row.authorization}) — ${row.reason}`);
      return 0;
    } catch (error) { console.error(error instanceof Error ? error.message : String(error)); return 1; }
  }
  if (args[0] !== 'preview') {
    console.error('Usage: cezar roadmap preview --input <planning.json> [--github]');
    return 1;
  }
  const inputAt = args.indexOf('--input');
  const inputPath = inputAt >= 0 ? args[inputAt + 1] : undefined;
  if (!inputPath || args.some((arg) => arg.startsWith('--') && arg !== '--input' && arg !== '--github')) {
    console.error('Usage: cezar roadmap preview --input <planning.json> [--github]');
    return 1;
  }
  try {
    const raw = await readFile(resolve(inputPath), 'utf8');
    if (raw.length > 1_000_000) throw new Error('planning input exceeds 1 MB');
    const input = roadmapInputSchema.parse(JSON.parse(raw));
    if (args.includes('--github')) {
      // Live discovery replaces fixture rows; a stale mock must never outrank
      // an authoritative live state for the same issue number.
      input.githubIssues = [];
      const workspace = await loadWorkspaceConfig();
      for (const allowed of input.allowedRepositories) {
        const project = workspace.projects.find((entry) => entry.id === allowed.projectId);
        if (!project) throw new Error(`allowed repository ${allowed.repo} has no registered projectId`);
        const data = await fetchGithub(project.root, true, 100);
        if (!data.available || data.repo?.toLowerCase() !== allowed.repo.toLowerCase()) {
          throw new Error(`GitHub issue source for ${allowed.repo} is unavailable or points to another repository`);
        }
        if (data.issuesNextCursor || data.issuesTotal !== data.issues.length) {
          throw new Error(`GitHub issue source for ${allowed.repo} is incomplete; use roadmap queue refresh for paginated discovery`);
        }
        input.githubIssues.push(...githubIssuesFromForge(allowed.repo, data.issues));
        for (const run of readRunIndexFromDisk(join(project.root, '.ai', 'cezar'))) {
          if (!run.issueNumber) continue;
          const id = `${allowed.repo}#${run.issueNumber}`;
          if (['queued', 'running', 'waiting', 'review'].includes(run.status)) input.runningTaskIds.push(id);
          if (run.status === 'done') input.completedTaskIds.push(id);
        }
      }
    }
    const preview = planRoadmap(input);
    const dir = join(cezarHomeDir(), 'roadmap');
    assertCezarHomeWriteIsSandboxed(dir);
    await mkdir(dir, { recursive: true });
    const path = join(dir, 'preview.json');
    const temporary = join(dir, `.preview-${randomUUID()}.tmp`);
    await writeFile(temporary, JSON.stringify(preview, null, 2) + '\n', { mode: 0o600 });
    await renameWithRetry(temporary, path);
    console.log(`Planning only — ${preview.rows.filter((row) => row.status === 'ready').length} ready; execution eligibility: none`);
    for (const row of preview.rows) {
      console.log(`${row.status.toUpperCase().padEnd(8)} P${row.priority} ${row.id} → ${row.preferredRunner}/${row.proposedWorkflow}`);
      console.log(`  ${row.reason}`);
    }
    console.log(`Saved: ${path}`);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}
