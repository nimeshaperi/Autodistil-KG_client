import { useEffect, useState } from 'react'
import { listRuns, type RunSummary } from '@/api/client'

interface RunHistoryProps {
  currentRunId: string | null
  onSelectRun: (runId: string) => void
}

const STATUS_COLORS: Record<string, string> = {
  running: 'bg-blue-500',
  completed: 'bg-green-500',
  failed: 'bg-red-500',
  queued: 'bg-yellow-500',
}

export default function RunHistory({ currentRunId, onSelectRun }: RunHistoryProps) {
  const [runs, setRuns] = useState<RunSummary[]>([])
  const [loading, setLoading] = useState(false)
  const [expanded, setExpanded] = useState(false)

  const fetchRuns = () => {
    setLoading(true)
    listRuns()
      .then(setRuns)
      .catch(() => {})
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    fetchRuns()
    const interval = setInterval(fetchRuns, 10_000)
    return () => clearInterval(interval)
  }, [])

  if (!expanded) {
    return (
      <button
        onClick={() => { setExpanded(true); fetchRuns() }}
        className="mb-4 text-sm text-muted-foreground hover:text-foreground flex items-center gap-1.5 transition-colors"
      >
        <span className="text-xs">&#9654;</span>
        Session History
        {runs.length > 0 && (
          <span className="bg-muted text-muted-foreground text-xs px-1.5 py-0.5 rounded-full">
            {runs.length}
          </span>
        )}
      </button>
    )
  }

  return (
    <div className="mb-4 border border-border rounded-lg bg-card">
      <div className="flex items-center justify-between px-3 py-2 border-b border-border">
        <button
          onClick={() => setExpanded(false)}
          className="text-sm font-medium text-foreground flex items-center gap-1.5"
        >
          <span className="text-xs">&#9660;</span>
          Session History
        </button>
        <button
          onClick={fetchRuns}
          disabled={loading}
          className="text-xs text-muted-foreground hover:text-foreground disabled:opacity-50"
        >
          {loading ? 'Refreshing...' : 'Refresh'}
        </button>
      </div>
      {runs.length === 0 ? (
        <p className="px-3 py-3 text-sm text-muted-foreground">No pipeline runs yet.</p>
      ) : (
        <ul className="divide-y divide-border max-h-48 overflow-y-auto">
          {runs.map((run) => {
            const isActive = run.run_id === currentRunId
            return (
              <li key={run.run_id}>
                <button
                  onClick={() => onSelectRun(run.run_id)}
                  className={`w-full text-left px-3 py-2 text-sm hover:bg-muted/50 transition-colors flex items-center gap-2 ${
                    isActive ? 'bg-primary/5 border-l-2 border-primary' : ''
                  }`}
                >
                  <span
                    className={`inline-block w-2 h-2 rounded-full flex-shrink-0 ${
                      STATUS_COLORS[run.status] || 'bg-gray-400'
                    }`}
                  />
                  <span className="font-mono text-xs truncate flex-1">{run.run_id}</span>
                  <span className="text-xs text-muted-foreground capitalize">{run.status}</span>
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
