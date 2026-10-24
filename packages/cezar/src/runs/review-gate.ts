/**
 * Optional diff-first review gate (#489, spec `2026-07-18-optional-review-gate`).
 *
 * The review gate (spec 009) used to fire for EVERY successful run whose worktree
 * held changes — parking it at `review` until a human accepts. This resolver makes
 * that opt-in. It mirrors `liveTitleUpdatesEnabled` (`src/runs/auto-name.ts`) but
 * with the OPPOSITE default: OFF unless explicitly turned on.
 *
 * Precedence: the `config.reviewGate` Settings toggle wins when set; otherwise the
 * `CEZ_REVIEW_GATE` env decides — enabled ONLY by the exact string `'1'` (anything
 * else, including `'true'`/`'yes'`/unset, is off); otherwise off.
 *
 * Autonomy is applied by the callers. A workflow's explicit `requiresReview`
 * overrides the legacy autonomous bypass at settlement.
 */
export function reviewGateEnabled(
  config: { reviewGate?: boolean },
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (config.reviewGate !== undefined) return config.reviewGate;
  return env.CEZ_REVIEW_GATE === '1';
}

/** A workflow may promise a human review. Refuse it before any agent starts if
 * the effective project settings cannot honor that promise. */
export function reviewPreflightError(
  requiresReview: boolean | undefined,
  config: { reviewGate?: boolean; taskWorkspace?: string },
  input: { autonomous?: boolean; worktree?: boolean; readOnly?: boolean },
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (!requiresReview) return undefined;
  if (!reviewGateEnabled(config, env)) return 'workflow requires review, but the review gate is disabled (enable Settings → Tasks review gate or CEZ_REVIEW_GATE=1)';
  if (input.readOnly) return 'workflow requires review, but read-only tasks cannot produce a review diff';
  if (input.worktree === false || (input.worktree === undefined && config.taskWorkspace === 'in-place')) {
    return 'workflow requires review in an isolated worktree';
  }
  return undefined;
}
