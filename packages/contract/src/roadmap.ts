import { z } from 'zod';

export const queuePriorityInputSchema = z.object({
  taskId: z.string().min(1).max(160),
  priority: z.number().int().min(1).max(5),
});

export const queueAuthorizationSchema = z.object({
  taskId: z.string().min(1), repo: z.string().min(1),
  scope: z.string().min(1), agent: z.enum(['claude', 'codex']), workflow: z.string().min(1),
  expiresAt: z.string().datetime(), revokedAt: z.string().datetime().optional(),
  maxAttempts: z.number().int().min(1), requireReview: z.literal(true),
  verificationCommand: z.string().min(1),
  audit: z.array(z.object({ at: z.string().datetime(), action: z.enum(['created', 'modified', 'revoked']), actor: z.literal('owner-cli') })),
});
export type QueueAuthorization = z.infer<typeof queueAuthorizationSchema>;

export const queueRowSchema = z.object({
  id: z.string(), repo: z.string(), title: z.string(), source: z.enum(['github', 'roadmap']),
  projectId: z.string().optional(), priority: z.number().int().min(1).max(5),
  dependencies: z.array(z.string()), blockers: z.array(z.string()),
  status: z.enum(['ready', 'blocked', 'active', 'completed', 'stale']),
  reason: z.string(), score: z.number(), proposedAgent: z.enum(['claude', 'codex']),
  proposedWorkflow: z.string(), authorization: z.enum(['none', 'active', 'expired', 'revoked']),
  lastRefresh: z.string().datetime().optional(), executionEligible: z.literal(false),
});
export const queueResponseSchema = z.object({
  mode: z.literal('planning-only'), updatedAt: z.string().datetime().optional(),
  rows: z.array(queueRowSchema), nextTaskId: z.string().nullable(),
  authorizations: z.array(queueAuthorizationSchema),
});
export type QueueResponse = z.infer<typeof queueResponseSchema>;
