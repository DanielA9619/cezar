import { z } from 'zod';
import type { ForgeItem } from '../server/forge/types.ts';

const repoName = z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, 'expected owner/repo');
const taskId = z.string().trim().min(1).max(160);
const runner = z.enum(['claude', 'codex']);
const priority = z.number().int().min(1).max(5);

export const roadmapInputSchema = z.object({
  allowedRepositories: z.array(z.object({ repo: repoName, projectId: z.string().optional() })).max(50),
  githubIssues: z.array(z.object({
    repo: repoName, number: z.number().int().positive(), title: z.string().min(1),
    url: z.string().url(), state: z.enum(['open', 'closed']), labels: z.array(z.string()),
  })).max(500).default([]),
  roadmaps: z.array(z.object({
    id: taskId, repo: repoName, title: z.string().min(1), priority: priority,
    approval: z.enum(['approved', 'pending', 'rejected']),
    dependencies: z.array(taskId).default([]), blockers: z.array(z.string()).default([]),
    preferredRunner: runner.default('claude'), githubIssue: z.number().int().positive().optional(),
    workflow: z.enum(['queue-mock-verify', 'queue-claude-pro-verify']).optional(),
  })).max(500).default([]),
  runningTaskIds: z.array(taskId).default([]),
  completedTaskIds: z.array(taskId).default([]),
});
export type RoadmapInput = z.infer<typeof roadmapInputSchema>;

export const planningRowSchema = z.object({
  id: taskId, repo: repoName, title: z.string(), source: z.enum(['github', 'roadmap']),
  priority, approval: z.enum(['approved', 'pending', 'rejected']),
  status: z.enum(['ready', 'blocked', 'excluded']), score: z.number().int(),
  reason: z.string(), preferredRunner: runner,
  /** Planning approval never authorizes a provider launch. */
  executionEligible: z.literal(false),
  proposedWorkflow: z.string(),
});
export const planningPreviewSchema = z.object({
  schemaVersion: z.literal(1), generatedAt: z.string().datetime(),
  mode: z.literal('planning-only'), rows: z.array(planningRowSchema),
});
export type PlanningPreview = z.infer<typeof planningPreviewSchema>;

function issuePriority(labels: readonly string[]): number {
  for (let p = 1; p <= 5; p++) if (labels.includes(`priority:p${p}`)) return p;
  return 3;
}

/** Reuse the forge driver's normalized GitHub issue shape; PRs cannot become work. */
export function githubIssuesFromForge(repo: string, items: readonly ForgeItem[]): RoadmapInput['githubIssues'] {
  return items.filter((item) => item.kind === 'issue').map((item) => ({
    repo, number: item.number, title: item.title, url: item.url,
    state: 'open' as const, labels: item.labels,
  }));
}

/** Pure ranking. Neither issue text nor roadmap approval can set executionEligible. */
export function planRoadmap(input: RoadmapInput, now = new Date()): PlanningPreview {
  const allowed = new Set(input.allowedRepositories.map(({ repo }) => repo.toLowerCase()));
  const running = new Set(input.runningTaskIds.map((id) => id.toLowerCase()));
  const completed = new Set(input.completedTaskIds.map((id) => id.toLowerCase()));
  const closedIssues = new Set(input.githubIssues.filter((issue) => issue.state === 'closed').map((issue) => `${issue.repo}#${issue.number}`));
  const seen = new Set<string>();
  const candidates: Array<{
    id: string; repo: string; title: string; source: 'github' | 'roadmap'; priority: number;
    approval: 'approved' | 'pending' | 'rejected'; dependencies: string[]; blockers: string[];
    preferredRunner: 'claude' | 'codex'; closed: boolean; workflow?: string;
  }> = [
    ...input.roadmaps.map((task) => ({
      ...task, source: 'roadmap' as const,
      closed: task.githubIssue !== undefined && closedIssues.has(`${task.repo}#${task.githubIssue}`),
      id: task.githubIssue ? `${task.repo}#${task.githubIssue}` : task.id,
    })),
    ...input.githubIssues.map((issue) => ({
      id: `${issue.repo}#${issue.number}`, repo: issue.repo, title: issue.title,
      source: 'github' as const, priority: issuePriority(issue.labels),
      approval: issue.labels.includes('roadmap-approved') ? 'approved' as const : 'pending' as const,
      dependencies: [] as string[], blockers: [] as string[], preferredRunner: 'claude' as const,
      closed: issue.state === 'closed',
    })),
  ];
  const rows = candidates.map((task) => {
    const reasons: string[] = [];
    const key = task.id.toLowerCase();
    if (!allowed.has(task.repo.toLowerCase())) reasons.push('repository is not on the operator allowlist');
    if (seen.has(key)) reasons.push('duplicate candidate');
    seen.add(key);
    if (task.closed || completed.has(key)) reasons.push('already completed');
    if (running.has(key)) reasons.push('already running');
    if (task.approval !== 'approved') reasons.push(`planning approval is ${task.approval}`);
    if (task.blockers.length) reasons.push(`blockers: ${task.blockers.join(', ')}`);
    const unmet = task.dependencies.filter((id) => !completed.has(id.toLowerCase()));
    if (unmet.length) reasons.push(`unmet dependencies: ${unmet.join(', ')}`);
    const status = reasons.length === 0 ? 'ready' as const
      : reasons.some((reason) => reason.includes('allowlist') || reason.includes('duplicate') || reason.includes('completed') || reason.includes('running') || reason.includes('rejected'))
        ? 'excluded' as const : 'blocked' as const;
    const score = (6 - task.priority) * 100 + (task.source === 'roadmap' ? 10 : 0);
    return {
      id: task.id, repo: task.repo, title: task.title, source: task.source,
      priority: task.priority, approval: task.approval, status, score,
      reason: reasons.length ? reasons.join('; ') : `approved ${task.source} candidate; priority P${task.priority}; dependencies satisfied`,
      preferredRunner: task.preferredRunner, executionEligible: false as const,
      proposedWorkflow: task.workflow ?? 'queue-mock-verify',
    };
  });
  rows.sort((a, b) => {
    const rank = { ready: 0, blocked: 1, excluded: 2 };
    return rank[a.status] - rank[b.status] || b.score - a.score || a.id.localeCompare(b.id);
  });
  return { schemaVersion: 1, generatedAt: now.toISOString(), mode: 'planning-only', rows };
}
