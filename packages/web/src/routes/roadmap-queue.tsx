import * as React from 'react'
import { startAuthentication, startRegistration } from '@simplewebauthn/browser'
import { resolveApiUrl, type QueueResponse } from '@open-mercato/cezar-api-client'

const endpoint = '/api/v1/workspace/roadmap-queue'

export function RoadmapQueueRoute() {
  const [queue, setQueue] = React.useState<QueueResponse | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [scope, setScope] = React.useState('.')
  const [verificationCommand, setVerificationCommand] = React.useState('cezar:mock-verify')
  const [pendingGrant, setPendingGrant] = React.useState<{ options: Parameters<typeof startAuthentication>[0]['optionsJSON']; grant: QueueResponse['authorizations'][number] } | null>(null)
  const [notice, setNotice] = React.useState<string | null>(null)
  const ownerPost = async <T,>(path: string, body?: unknown): Promise<T> => {
    const response = await fetch(resolveApiUrl(`${endpoint}/owner/${path}`), {
      method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}),
    })
    const result = await response.json() as T & { error?: string }
    if (!response.ok) throw new Error(result.error ?? `Windows Hello request failed (${response.status})`)
    return result
  }
  const enroll = async () => {
    setBusy(true)
    try {
      const optionsJSON = await ownerPost<Parameters<typeof startRegistration>[0]['optionsJSON']>('enroll/start')
      const response = await startRegistration({ optionsJSON })
      await ownerPost('enroll/finish', { response })
      setNotice('Windows Hello owner credential enrolled. Review each task before approving it.')
      await load()
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)) }
    finally { setBusy(false) }
  }
  const prepare = async (row: QueueResponse['rows'][number]) => {
    setBusy(true)
    try {
      const grant = { taskId: row.id, repo: row.repo, scope: scope.trim(), agent: row.proposedAgent,
        workflow: row.proposedWorkflow, expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
        maxAttempts: 2, requireReview: true, verificationCommand: verificationCommand.trim() }
      const answer = await ownerPost<NonNullable<typeof pendingGrant>>('grant/start', { grant })
      setPendingGrant(answer)
      setError(null)
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)) }
    finally { setBusy(false) }
  }
  const finishGrant = async () => {
    if (!pendingGrant) return
    setBusy(true)
    try {
      const response = await startAuthentication({ optionsJSON: pendingGrant.options })
      await ownerPost('grant/finish', { response })
      setPendingGrant(null)
      setNotice('Exact task grant verified by Windows Hello and stored. Queue execution remains mock-only.')
      await load()
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)) }
    finally { setBusy(false) }
  }
  const revoke = async (repo: string, taskId: string) => {
    setBusy(true)
    try {
      const optionsJSON = await ownerPost<Parameters<typeof startAuthentication>[0]['optionsJSON']>('revoke/start', { repo, taskId })
      const response = await startAuthentication({ optionsJSON })
      await ownerPost('revoke/finish', { response })
      setNotice(`Authorization revoked for ${taskId}.`)
      await load()
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)) }
    finally { setBusy(false) }
  }
  const load = React.useCallback(async () => {
    try {
      const response = await fetch(resolveApiUrl(endpoint), { credentials: 'include' })
      if (!response.ok) throw new Error(`Queue unavailable (${response.status})`)
      setQueue(await response.json() as QueueResponse)
      setError(null)
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)) }
  }, [])
  React.useEffect(() => { void load() }, [load])
  const priority = async (taskId: string, value: number) => {
    setBusy(true)
    try {
      const response = await fetch(resolveApiUrl(`${endpoint}/priority`), {
        method: 'PATCH', credentials: 'include', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ taskId, priority: value }),
      })
      if (!response.ok) throw new Error(`Priority update failed (${response.status})`)
      setQueue(await response.json() as QueueResponse)
      setError(null)
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)) }
    finally { setBusy(false) }
  }
  return <main className="mx-auto max-w-6xl space-y-5 p-6" data-route="roadmap-queue">
    <header className="flex items-start justify-between gap-3">
      <div><h1 className="text-2xl font-semibold">Roadmap work queue</h1>
        <p className="text-sm text-muted-foreground">Authorized execution is limited to bundled mocks in marked disposable projects. Refreshing this page never starts an agent.</p></div>
      <button type="button" className="rounded border px-3 py-1 text-sm" onClick={() => void load()}>Reload</button>
    </header>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {notice && <p role="status" className="text-sm">{notice}</p>}
    <section className="rounded-lg border p-4 space-y-3">
      <h2 className="font-semibold">Owner authorization</h2>
      <p className="text-sm text-muted-foreground">Windows Hello signs a fresh challenge for the exact repository, task revision, scope, agent, workflow, expiration and attempt limit. The server verifies the signature and user verification. No passphrase fallback is available.</p>
      {!queue?.ownerEnrolled && <button type="button" disabled={busy} onClick={() => void enroll()} className="rounded border px-3 py-1 text-sm">Enroll Windows Hello</button>}
      {queue?.ownerEnrolled && <div className="flex flex-wrap gap-3 text-sm">
        <label>Work scope <input value={scope} onChange={(event) => setScope(event.target.value)} className="ml-1 rounded border bg-background p-1" /></label>
        <label>Verification command <input value={verificationCommand} onChange={(event) => setVerificationCommand(event.target.value)} className="ml-1 rounded border bg-background p-1" /></label>
      </div>}
      {pendingGrant && <div className="rounded border p-3 text-sm space-y-2">
        <p className="font-medium">Confirm this exact approval</p>
        <p>{pendingGrant.grant.repo} · {pendingGrant.grant.taskId} · revision {pendingGrant.grant.taskRevision} · {pendingGrant.grant.agent}/{pendingGrant.grant.workflow}</p>
        <p>Repository: {pendingGrant.grant.repositoryRoot}. Scope: {pendingGrant.grant.scope}. Verify: {pendingGrant.grant.verificationCommand}. Expires: {new Date(pendingGrant.grant.expiresAt).toLocaleString()}. Maximum attempts: {pendingGrant.grant.maxAttempts}. Human review required.</p>
        <button type="button" disabled={busy} onClick={() => void finishGrant()} className="rounded border px-3 py-1">Verify with Windows Hello</button>
        <button type="button" onClick={() => setPendingGrant(null)} className="ml-2 rounded border px-3 py-1">Cancel</button>
      </div>}
    </section>
    <section className="rounded-lg border p-4">
      <h2 className="font-semibold">Next selection preview</h2>
      <p className="text-sm">{queue?.nextTaskId ?? 'No eligible task'}{queue?.nextTaskId ? ' is next for explicit mock dispatch.' : ''}</p>
      <p className="text-xs text-muted-foreground">Queue updated {queue?.updatedAt ? new Date(queue.updatedAt).toLocaleString() : 'never'}. GitHub refresh is an explicit CLI action.</p>
    </section>
    <div className="overflow-x-auto rounded-lg border">
      <table className="w-full min-w-[1100px] text-left text-sm"><thead className="bg-muted/50"><tr>
        {['Project', 'Issue or task', 'Priority', 'Dependencies / blockers', 'Agent', 'Authorization', 'Last refresh', 'Execution', 'Status and reason'].map((label) => <th key={label} className="p-3 font-medium">{label}</th>)}
      </tr></thead><tbody>{queue?.rows.map((row) => <tr key={`${row.repo}:${row.id}`} className="border-t align-top">
        <td className="p-3">{row.projectId ?? row.repo}</td><td className="p-3"><span className="font-medium">{row.title}</span><br /><span className="text-xs text-muted-foreground">{row.id}</span></td>
        <td className="p-3"><select aria-label={`Priority for ${row.id}`} disabled={busy} value={row.priority} onChange={(event) => void priority(row.id, Number(event.target.value))} className="rounded border bg-background p-1">{[1, 2, 3, 4, 5].map((value) => <option key={value} value={value}>P{value}</option>)}</select></td>
        <td className="p-3">{[...row.dependencies, ...row.blockers].join(', ') || 'None'}</td><td className="p-3">{row.proposedAgent}</td>
        <td className="p-3">{row.authorization}</td><td className="p-3">{row.lastRefresh ? new Date(row.lastRefresh).toLocaleString() : 'Unverified'}</td>
        <td className="p-3">{row.executionEligible ? 'Eligible for mock dispatch' : row.executionReasons.join('; ')}<br /><span className="text-xs text-muted-foreground">Attempts {row.attemptsUsed}/{row.maxAttempts ?? '—'} · {row.reviewRequired ? 'Human review required' : 'Review not authorized'}{row.leaseOwner ? ` · owner ${row.leaseOwner}` : ''}{row.executionStatus ? ` · ${row.executionStatus}` : ''}{row.verificationProgress ? ` · ${row.verificationProgress}` : ''}</span></td>
        <td className="p-3"><span className="font-medium">{row.status}</span><br /><span className="text-xs text-muted-foreground">{row.reason}</span>{queue?.ownerEnrolled && row.status === 'ready' && <><br /><button type="button" disabled={busy || !scope.trim() || !verificationCommand.trim()} onClick={() => void prepare(row)} className="mt-2 rounded border px-2 py-1">Prepare exact approval</button></>}</td>
      </tr>)}</tbody></table>
      {queue?.rows.length === 0 && <p className="p-4 text-sm text-muted-foreground">No allowlisted work is loaded. Use the roadmap queue CLI to load planning input.</p>}
    </div>
    {Boolean(queue?.authorizations.length) && <section className="rounded-lg border p-4"><h2 className="font-semibold">Owner authorizations</h2><ul className="mt-2 space-y-2 text-sm">{queue?.authorizations.map((auth) => <li key={`${auth.repo}:${auth.taskId}`} className="border-t pt-2">{auth.repo} · {auth.taskId} · {auth.agent}/{auth.workflow} · scope: {auth.scope} · max attempts: {auth.maxAttempts} · verify: {auth.verificationCommand} · expires: {new Date(auth.expiresAt).toLocaleString()} · {auth.revokedAt ? 'revoked' : auth.credentialId ? 'Windows Hello verified' : 'legacy planning record'}{auth.credentialId && !auth.revokedAt && <button type="button" disabled={busy} onClick={() => void revoke(auth.repo, auth.taskId)} className="ml-2 rounded border px-2 py-1">Revoke with Windows Hello</button>}<br /><span className="text-xs text-muted-foreground">Audit: {auth.audit.map((event) => `${event.action} by ${event.actor} ${new Date(event.at).toLocaleString()}`).join('; ')}</span></li>)}</ul></section>}
    {Boolean(queue?.recentDecisions.length) && <section className="rounded-lg border p-4"><h2 className="font-semibold">Recent decisions</h2><ul className="mt-2 space-y-1 text-xs text-muted-foreground">{queue?.recentDecisions.map((decision, index) => <li key={`${decision.at}-${index}`}>{new Date(decision.at).toLocaleString()} · {decision.reason}</li>)}</ul></section>}
  </main>
}
