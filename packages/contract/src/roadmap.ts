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
  /** Absent on pre-1C planning records. Such records can never authorize execution. */
  repositoryRoot: z.string().min(1).optional(), taskRevision: z.string().min(1).optional(), workflowRevision: z.string().min(1).optional(),
  credentialId: z.string().min(1).optional(), approvedAt: z.string().datetime().optional(),
  audit: z.array(z.object({ at: z.string().datetime(), action: z.enum(['created', 'modified', 'revoked']), actor: z.enum(['owner-cli', 'windows-hello']) })),
});
export type QueueAuthorization = z.infer<typeof queueAuthorizationSchema>;

export const queueAuthorizationRequestSchema = queueAuthorizationSchema.omit({ audit: true, revokedAt: true, credentialId: true, approvedAt: true, repositoryRoot: true, taskRevision: true, workflowRevision: true });
export const queueOwnerGrantBeginSchema = z.object({ grant: queueAuthorizationRequestSchema });
export const queueOwnerRevokeBeginSchema = z.object({ repo: z.string().min(1), taskId: z.string().min(1) });
export const queueOwnerRegistrationResponseSchema = z.object({
  id: z.string().min(1), rawId: z.string().min(1), type: z.literal('public-key'),
  authenticatorAttachment: z.string().optional(),
  clientExtensionResults: z.record(z.string(), z.unknown()),
  response: z.object({ clientDataJSON: z.string().min(1), attestationObject: z.string().min(1) }).passthrough(),
});
export const queueOwnerAssertionResponseSchema = z.object({
  id: z.string().min(1), rawId: z.string().min(1), type: z.literal('public-key'),
  clientExtensionResults: z.record(z.string(), z.unknown()),
  response: z.object({ clientDataJSON: z.string().min(1), authenticatorData: z.string().min(1), signature: z.string().min(1), userHandle: z.string().optional() }).passthrough(),
});
export const queueOwnerDecisionSchema = z.object({ response: queueOwnerAssertionResponseSchema });
export const queueOwnerEnrollmentSchema = z.object({ response: queueOwnerRegistrationResponseSchema });

export const queueRowSchema = z.object({
  id: z.string(), repo: z.string(), title: z.string(), source: z.enum(['github', 'roadmap']),
  projectId: z.string().optional(), priority: z.number().int().min(1).max(5),
  dependencies: z.array(z.string()), blockers: z.array(z.string()),
  status: z.enum(['ready', 'blocked', 'active', 'completed', 'stale']),
  reason: z.string(), score: z.number(), proposedAgent: z.enum(['claude', 'codex']),
  proposedWorkflow: z.string(), authorization: z.enum(['none', 'active', 'expired', 'revoked']),
  lastRefresh: z.string().datetime().optional(), executionEligible: z.boolean(),
  executionReasons: z.array(z.string()), attemptsUsed: z.number().int().nonnegative(),
  maxAttempts: z.number().int().positive().optional(), leaseOwner: z.string().optional(),
  executionStatus: z.string().optional(), verificationProgress: z.string().optional(),
  reviewRequired: z.boolean(),
});
export const queueResponseSchema = z.object({
  mode: z.enum(['planning-only', 'mock-only']), updatedAt: z.string().datetime().optional(),
  rows: z.array(queueRowSchema), nextTaskId: z.string().nullable(),
  authorizations: z.array(queueAuthorizationSchema),
  ownerEnrolled: z.boolean(),
  recentDecisions: z.array(z.object({ at: z.string().datetime(), reason: z.string() })).default([]),
});
export type QueueResponse = z.infer<typeof queueResponseSchema>;
