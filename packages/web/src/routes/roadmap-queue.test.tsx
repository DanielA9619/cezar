import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { startAuthentication } from '@simplewebauthn/browser'
import type { QueueResponse } from '@open-mercato/cezar-api-client'
import { RoadmapQueueRoute } from './roadmap-queue'

vi.mock('@simplewebauthn/browser', () => ({ startAuthentication: vi.fn(), startRegistration: vi.fn() }))
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks() })

const row: QueueResponse['rows'][number] = {
  id: 'finite-sum-one', repo: 'local/finite-sum', title: 'Implement finite sum', source: 'roadmap',
  priority: 1, dependencies: [], blockers: [], status: 'ready', reason: 'Ready for owner review', score: 510,
  proposedAgent: 'claude', proposedWorkflow: 'queue-claude-pro-verify', authorization: 'none',
  executionEligible: false, executionReasons: ['Real dispatch disabled'], attemptsUsed: 0, reviewRequired: false,
}
const queue: QueueResponse = { mode: 'mock-only', rows: [row], nextTaskId: null, authorizations: [], ownerEnrolled: true, recentDecisions: [] }
const prepared = { options: { challenge: 'test-challenge' }, grant: {
  taskId: row.id, repo: row.repo, repositoryRoot: 'F:/disposable/finite-sum', scope: 'sum.mjs', agent: 'claude',
  executionMode: 'claude-pro', workflow: row.proposedWorkflow, taskRevision: 'task-sha', workflowRevision: 'workflow-sha',
  verificationCommand: 'cezar:sum-verify', expiresAt: '2099-01-01T00:00:00.000Z', maxAttempts: 2, requireReview: true,
} }

it('shows preparation progress, then opens the exact details in a focused dialog without signing', async () => {
  let finish!: (response: Response) => void
  const fetcher = vi.fn().mockResolvedValueOnce(Response.json(queue))
    .mockImplementationOnce(() => new Promise<Response>(resolve => { finish = resolve }))
  vi.stubGlobal('fetch', fetcher)
  render(<RoadmapQueueRoute />)
  fireEvent.click(await screen.findByRole('button', { name: 'Prepare exact approval' }))
  expect((await screen.findByRole('button', { name: 'Preparing…' }) as HTMLButtonElement).disabled).toBe(true)
  await act(async () => { finish(Response.json(prepared)) })
  const dialog = await screen.findByRole('dialog', { name: 'Confirm this exact approval' })
  expect(dialog.contains(document.activeElement)).toBe(true)
  expect(within(dialog).getByText(/workflow-sha/)).toBeTruthy()
  expect(within(dialog).getByText(/Scope: sum.mjs/)).toBeTruthy()
  expect(within(dialog).getByRole('button', { name: 'Verify with Windows Hello' })).toBeTruthy()
  const [url, request] = fetcher.mock.calls[1]!
  expect(url).toBe('/api/v1/workspace/roadmap-queue/owner/grant/start')
  expect(JSON.parse(request.body).grant).toMatchObject({ taskId: row.id, executionMode: 'claude-pro', scope: 'sum.mjs', verificationCommand: 'cezar:sum-verify' })
  expect(startAuthentication).not.toHaveBeenCalled()
  expect(fetcher).toHaveBeenCalledTimes(2)
})

it.each([
  [409, () => Response.json({ error: 'Real fixture contains unapproved path: notes.md' }, { status: 409 }), 'Real fixture contains unapproved path: notes.md'],
  [503, () => new Response('Unavailable', { status: 503, statusText: 'Service Unavailable' }), 'Service Unavailable'],
] as const)('shows HTTP %s errors beside Prepare and clears them on a successful retry', async (status, response, message) => {
  const fetcher = vi.fn().mockResolvedValueOnce(Response.json(queue))
    .mockImplementationOnce(async () => response()).mockResolvedValueOnce(Response.json(prepared))
  vi.stubGlobal('fetch', fetcher)
  render(<RoadmapQueueRoute />)
  const button = await screen.findByRole('button', { name: 'Prepare exact approval' })
  const cell = button.closest('td')!
  fireEvent.click(button)
  const error = await within(cell).findByRole('alert')
  expect(error.textContent).toContain(`HTTP ${status}`)
  expect(error.textContent).toContain(message)
  expect(screen.queryByRole('dialog')).toBeNull()
  fireEvent.click(button)
  await screen.findByRole('dialog', { name: 'Confirm this exact approval' })
  expect(within(cell).queryByRole('alert')).toBeNull()
  expect(startAuthentication).not.toHaveBeenCalled()
})
