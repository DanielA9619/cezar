import * as React from 'react'
import { resolveApiUrl, type QueueResponse } from '@open-mercato/cezar-api-client'

const endpoint = '/api/v1/workspace/roadmap-queue'

export function RoadmapQueueRoute() {
  const [queue, setQueue] = React.useState<QueueResponse | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState(false)
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
        <p className="text-sm text-muted-foreground">Planning only. Refreshing this page and changing priority never starts an agent.</p></div>
      <button type="button" className="rounded border px-3 py-1 text-sm" onClick={() => void load()}>Reload</button>
    </header>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    <section className="rounded-lg border p-4">
      <h2 className="font-semibold">Next selection preview</h2>
      <p className="text-sm">{queue?.nextTaskId ?? 'No ready task'}{queue?.nextTaskId ? ' would be selected for planning.' : ''}</p>
      <p className="text-xs text-muted-foreground">Queue updated {queue?.updatedAt ? new Date(queue.updatedAt).toLocaleString() : 'never'}. GitHub refresh is an explicit CLI action.</p>
    </section>
    <div className="overflow-x-auto rounded-lg border">
      <table className="w-full min-w-[900px] text-left text-sm"><thead className="bg-muted/50"><tr>
        {['Project', 'Issue or task', 'Priority', 'Dependencies / blockers', 'Agent', 'Authorization', 'Last refresh', 'Status and reason'].map((label) => <th key={label} className="p-3 font-medium">{label}</th>)}
      </tr></thead><tbody>{queue?.rows.map((row) => <tr key={`${row.repo}:${row.id}`} className="border-t align-top">
        <td className="p-3">{row.projectId ?? row.repo}</td><td className="p-3"><span className="font-medium">{row.title}</span><br /><span className="text-xs text-muted-foreground">{row.id}</span></td>
        <td className="p-3"><select aria-label={`Priority for ${row.id}`} disabled={busy} value={row.priority} onChange={(event) => void priority(row.id, Number(event.target.value))} className="rounded border bg-background p-1">{[1, 2, 3, 4, 5].map((value) => <option key={value} value={value}>P{value}</option>)}</select></td>
        <td className="p-3">{[...row.dependencies, ...row.blockers].join(', ') || 'None'}</td><td className="p-3">{row.proposedAgent}</td>
        <td className="p-3">{row.authorization}</td><td className="p-3">{row.lastRefresh ? new Date(row.lastRefresh).toLocaleString() : 'Unverified'}</td>
        <td className="p-3"><span className="font-medium">{row.status}</span><br /><span className="text-xs text-muted-foreground">{row.reason}</span></td>
      </tr>)}</tbody></table>
      {queue?.rows.length === 0 && <p className="p-4 text-sm text-muted-foreground">No allowlisted work is loaded. Use the roadmap queue CLI to load planning input.</p>}
    </div>
    {Boolean(queue?.authorizations.length) && <section className="rounded-lg border p-4"><h2 className="font-semibold">Owner authorizations</h2><ul className="mt-2 space-y-2 text-sm">{queue?.authorizations.map((auth) => <li key={`${auth.repo}:${auth.taskId}`} className="border-t pt-2">{auth.repo} · {auth.taskId} · {auth.agent}/{auth.workflow} · scope: {auth.scope} · max attempts: {auth.maxAttempts} · verify: {auth.verificationCommand} · expires: {new Date(auth.expiresAt).toLocaleString()} · {auth.revokedAt ? 'revoked' : 'stored only'}<br /><span className="text-xs text-muted-foreground">Audit: {auth.audit.map((event) => `${event.action} by ${event.actor} ${new Date(event.at).toLocaleString()}`).join('; ')}</span></li>)}</ul></section>}
  </main>
}
