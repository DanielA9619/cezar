import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import lockfile from 'proper-lockfile';
import { z } from 'zod';
import { queueAuthorizationSchema, queueResponseSchema, type QueueAuthorization, type QueueResponse } from '@open-mercato/cezar-contract';
import { assertCezarHomeWriteIsSandboxed, cezarHomeDir } from '../paths.ts';
import { renameWithRetry } from '../fs-rename.ts';
import { planRoadmap, roadmapInputSchema, type RoadmapInput } from './planner.ts';

const sourceSchema = z.object({ verifiedAt: z.string().datetime().optional(), complete: z.boolean(), reason: z.string().optional() });
const reservationSchema = z.object({ taskId: z.string(), owner: z.string(), expiresAt: z.string().datetime() });
const decisionSchema = z.object({ at: z.string().datetime(), nextTaskId: z.string().nullable(), reason: z.string(), considered: z.number().int().nonnegative() });
const executionClaimSchema = z.object({
  taskId: z.string().min(1), repo: z.string().min(1), claimId: z.string().uuid(),
  owner: z.string().min(1), generation: z.number().int().positive(),
  claimedAt: z.string().datetime(), heartbeatAt: z.string().datetime(),
  state: z.enum(['claimed', 'running', 'review', 'failed', 'uncertain']),
  runId: z.string().optional(), reason: z.string().optional(),
});
export type ExecutionClaim = z.infer<typeof executionClaimSchema>;
const ownerAuthenticatorSchema = z.object({
  id: z.string().min(1), publicKey: z.string().min(1), counter: z.number().int().nonnegative(),
  transports: z.array(z.string()).optional(), enrolledAt: z.string().datetime(),
});
const pendingOwnerChallengeSchema = z.object({
  kind: z.enum(['enroll', 'grant', 'revoke']), challenge: z.string().min(1),
  origin: z.string().url(), rpId: z.string().min(1), expiresAt: z.string().datetime(),
  grant: queueAuthorizationSchema.omit({ audit: true }).optional(),
});
export const queueStateSchema = z.object({
  version: z.literal(1), input: roadmapInputSchema,
  sources: z.record(z.string(), sourceSchema).default({}),
  priorityOverrides: z.record(z.string(), z.number().int().min(1).max(5)).default({}),
  authorizations: z.array(queueAuthorizationSchema).default([]),
  ownerAuthenticator: ownerAuthenticatorSchema.optional(),
  pendingOwnerChallenge: pendingOwnerChallengeSchema.optional(),
  reservations: z.array(reservationSchema).default([]),
  executionClaims: z.array(executionClaimSchema).default([]),
  decisions: z.array(decisionSchema).default([]),
  updatedAt: z.string().datetime(),
});
export type QueueState = z.infer<typeof queueStateSchema>;
const emptyInput = roadmapInputSchema.parse({ allowedRepositories: [] });
const emptyState = (): QueueState => ({ version: 1, input: emptyInput, sources: {}, priorityOverrides: {}, authorizations: [], reservations: [], executionClaims: [], decisions: [], updatedAt: new Date(0).toISOString() });
const taskKey = (id: string) => id.toLowerCase();
const repoKey = (repo: string) => repo.toLowerCase();
const FRESH_MS = 15 * 60_000;

function paths() { const dir = join(cezarHomeDir(), 'roadmap'); return { dir, file: join(dir, 'queue.json') }; }

export async function readQueueState(): Promise<QueueState> {
  try { return queueStateSchema.parse(JSON.parse(await readFile(paths().file, 'utf8'))); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyState();
    throw new Error('Roadmap queue is unreadable; refusing to make planning decisions');
  }
}

/** Every read/modify/write uses one cross-process lease and re-reads under it. */
export async function updateQueue(mutator: (state: QueueState) => void | Promise<void>): Promise<QueueState> {
  const { dir, file } = paths();
  assertCezarHomeWriteIsSandboxed(dir);
  await mkdir(dir, { recursive: true });
  const release = await lockfile.lock(dir, { realpath: false, lockfilePath: join(dir, 'queue.lock'), stale: 30_000, update: 5_000, retries: { retries: 8, factor: 1.4, minTimeout: 40, maxTimeout: 200 } });
  try {
    const state = await readQueueState();
    await mutator(state);
    state.updatedAt = new Date().toISOString();
    const preview = queuePreview(state);
    state.decisions.push({ at: state.updatedAt, nextTaskId: preview.nextTaskId,
      reason: preview.rows.find((row) => row.id === preview.nextTaskId)?.reason ?? 'No verified ready task', considered: preview.rows.length });
    state.decisions = state.decisions.slice(-200);
    const temporary = join(dir, `.queue-${randomUUID()}.tmp`);
    await writeFile(temporary, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
    await renameWithRetry(temporary, file);
    return state;
  } finally { await release(); }
}

export async function saveQueueInput(input: RoadmapInput): Promise<QueueState> {
  const parsed = roadmapInputSchema.parse(input);
  const roadmapIds = parsed.roadmaps.map((task) => task.id.toLowerCase());
  if (new Set(roadmapIds).size !== roadmapIds.length) throw new Error('Roadmap task IDs must be unique across projects');
  return updateQueue((state) => {
    // The allowlist is supplied only by this local owner command, never from GitHub text.
    state.input = parsed;
    state.sources = {};
    state.reservations = [];
  });
}

export function authorizationStatus(auth: QueueAuthorization | undefined, now: Date): 'none' | 'active' | 'expired' | 'revoked' {
  if (!auth) return 'none';
  if (auth.revokedAt) return 'revoked';
  return Date.parse(auth.expiresAt) > now.getTime() ? 'active' : 'expired';
}

/** Ranking is a preview. Even an active owner authorization cannot flip executionEligible. */
export function queuePreview(state: QueueState, now = new Date()): QueueResponse {
  const allowed = new Map(state.input.allowedRepositories.map((entry) => [repoKey(entry.repo), entry.projectId]));
  const planned = planRoadmap(state.input, now);
  const tasks = new Map(state.input.roadmaps.map((task) => [taskKey(task.githubIssue ? `${task.repo}#${task.githubIssue}` : task.id), task]));
  const rows = planned.rows.filter((row, index, all) => all.findIndex((candidate) => taskKey(candidate.id) === taskKey(row.id)) === index).map((row) => {
    const task = tasks.get(taskKey(row.id));
    const source = state.sources[repoKey(row.repo)];
    const issue = row.source === 'github' || task?.githubIssue !== undefined;
    const stale = issue && (!source?.complete || !source.verifiedAt || now.getTime() - Date.parse(source.verifiedAt) > FRESH_MS);
    const reserved = state.reservations.some((entry) => taskKey(entry.taskId) === taskKey(row.id) && Date.parse(entry.expiresAt) > now.getTime());
    const priority = state.priorityOverrides[taskKey(row.id)] ?? row.priority;
    const auth = state.authorizations.find((entry) => taskKey(entry.taskId) === taskKey(row.id) && repoKey(entry.repo) === repoKey(row.repo));
    const claim = state.executionClaims.find((entry) => taskKey(entry.taskId) === taskKey(row.id) && repoKey(entry.repo) === repoKey(row.repo));
    const status = stale ? 'stale' as const : reserved || state.input.runningTaskIds.some((id) => taskKey(id) === taskKey(row.id)) ? 'active' as const
      : row.reason.includes('already completed') ? 'completed' as const : row.status === 'ready' ? 'ready' as const : 'blocked' as const;
    const score = (6 - priority) * 100 + (row.source === 'roadmap' ? 10 : 0);
    return {
      id: row.id, repo: row.repo, title: row.title, source: row.source, projectId: allowed.get(repoKey(row.repo)),
      priority, dependencies: task?.dependencies ?? [], blockers: task?.blockers ?? [], status,
      score, reason: `${stale ? `GitHub state unverified: ${source?.reason ?? 'refresh required'}` : reserved ? 'reserved by another planner' : row.reason}${state.priorityOverrides[taskKey(row.id)] === undefined ? '' : `; owner priority override P${priority}`}`,
      proposedAgent: row.preferredRunner, proposedWorkflow: row.proposedWorkflow,
      authorization: authorizationStatus(auth, now), lastRefresh: source?.verifiedAt, executionEligible: false,
      executionReasons: ['Execution checks have not run'], attemptsUsed: 0,
      ...(auth ? { maxAttempts: auth.maxAttempts } : {}), ...(claim ? { leaseOwner: claim.owner, executionStatus: claim.state } : {}),
      reviewRequired: auth?.requireReview === true,
    };
  });
  const order = { ready: 0, blocked: 1, active: 2, stale: 3, completed: 4 };
  rows.sort((a, b) => order[a.status] - order[b.status] || b.score - a.score || a.id.localeCompare(b.id));
  return queueResponseSchema.parse({ mode: 'planning-only', updatedAt: state.updatedAt, rows, nextTaskId: rows.find((row) => row.status === 'ready')?.id ?? null, authorizations: state.authorizations, ownerEnrolled: !!state.ownerAuthenticator,
    recentDecisions: state.decisions.slice(-10).map((entry) => ({ at: entry.at, reason: entry.reason })) });
}

export async function setPriority(taskId: string, priority: number): Promise<QueueResponse> {
  const state = await updateQueue((current) => {
    if (!Number.isInteger(priority) || priority < 1 || priority > 5) throw new Error('Invalid priority');
    if (!queuePreview(current).rows.some((row) => taskKey(row.id) === taskKey(taskId))) throw new Error('Unknown task');
    current.priorityOverrides[taskKey(taskId)] = priority;
  });
  return queuePreview(state);
}

export async function reservePlanningTask(taskId: string, owner: string, now = new Date()): Promise<boolean> {
  let reserved = false;
  await updateQueue((state) => {
    state.reservations = state.reservations.filter((entry) => Date.parse(entry.expiresAt) > now.getTime());
    if (queuePreview(state, now).rows.find((row) => taskKey(row.id) === taskKey(taskId))?.status !== 'ready') return;
    state.reservations.push({ taskId, owner, expiresAt: new Date(now.getTime() + 60_000).toISOString() });
    reserved = true;
  });
  return reserved;
}

/** Claims are never stolen on heartbeat expiry: a missing heartbeat proves no process cleanup. */
export async function claimExecution(
  repo: string, taskId: string, owner: string,
  eligible: (state: QueueState) => boolean,
): Promise<ExecutionClaim | undefined> {
  let claimed: ExecutionClaim | undefined;
  await updateQueue((state) => {
    if (!eligible(state)) return;
    const previous = state.executionClaims.find((entry) => repoKey(entry.repo) === repoKey(repo) && taskKey(entry.taskId) === taskKey(taskId));
    if (previous) return;
    const now = new Date().toISOString();
    claimed = executionClaimSchema.parse({ repo, taskId, owner, claimId: randomUUID(),
      generation: 1, claimedAt: now, heartbeatAt: now, state: 'claimed' });
    state.executionClaims = state.executionClaims.filter((entry) => !(repoKey(entry.repo) === repoKey(repo) && taskKey(entry.taskId) === taskKey(taskId)));
    state.executionClaims.push(claimed);
  });
  return claimed;
}

/** Every worker update carries its fencing token; a stale worker cannot advance its claim. */
export async function advanceExecutionClaim(
  claim: Pick<ExecutionClaim, 'repo' | 'taskId' | 'claimId' | 'generation'>,
  update: Pick<ExecutionClaim, 'state'> & Partial<Pick<ExecutionClaim, 'runId' | 'reason'>>,
): Promise<boolean> {
  let advanced = false;
  await updateQueue((state) => {
    const current = state.executionClaims.find((entry) => repoKey(entry.repo) === repoKey(claim.repo) && taskKey(entry.taskId) === taskKey(claim.taskId));
    if (!current || current.claimId !== claim.claimId || current.generation !== claim.generation) return;
    if (['review', 'failed', 'uncertain'].includes(current.state)) return;
    if (current.state === 'claimed' && !['claimed', 'running', 'failed', 'uncertain'].includes(update.state)) return;
    if (current.state === 'running' && !['running', 'review', 'failed', 'uncertain'].includes(update.state)) return;
    current.state = update.state;
    current.heartbeatAt = new Date().toISOString();
    if (update.runId !== undefined) current.runId = update.runId;
    if (update.reason !== undefined) current.reason = update.reason.slice(0, 300);
    advanced = true;
  });
  return advanced;
}

export async function ownerAuthorization(input: Omit<QueueAuthorization, 'audit'>, action: 'grant' | 'revoke', ownerVerified: boolean): Promise<QueueAuthorization> {
  if (!ownerVerified) throw new Error('Owner authorization requires a trusted interactive CLI action');
  let result: QueueAuthorization | undefined;
  await updateQueue((state) => {
    const now = new Date().toISOString();
    const index = state.authorizations.findIndex((entry) => taskKey(entry.taskId) === taskKey(input.taskId) && repoKey(entry.repo) === repoKey(input.repo));
    if (!state.input.allowedRepositories.some((entry) => repoKey(entry.repo) === repoKey(input.repo))) throw new Error('Repository is not allowlisted');
    if (!queuePreview(state).rows.some((row) => taskKey(row.id) === taskKey(input.taskId) && repoKey(row.repo) === repoKey(input.repo))) throw new Error('Unknown task identity');
    if (action === 'revoke' && index < 0) throw new Error('Authorization does not exist');
    const previous = state.authorizations[index];
    result = queueAuthorizationSchema.parse({ ...input, revokedAt: action === 'revoke' ? now : undefined,
      audit: [...(previous?.audit ?? []), { at: now, action: action === 'revoke' ? 'revoked' : previous ? 'modified' : 'created', actor: 'owner-cli' }], });
    if (index < 0) state.authorizations.push(result); else state.authorizations[index] = result;
  });
  return result!;
}
