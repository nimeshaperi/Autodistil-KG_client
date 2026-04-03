import { Settings, Activity, FileOutput, Terminal, History, Circle } from 'lucide-react'
import type { RunSummary } from '../api/client'
import { listRuns } from '../api/client'
import { useEffect, useState, useCallback } from 'react'

export type PageId = 'configure' | 'monitor' | 'results' | 'inference'

const NAV_ITEMS: { id: PageId; label: string; icon: typeof Settings }[] = [
  { id: 'configure', label: 'Configure', icon: Settings },
  { id: 'monitor', label: 'Monitor', icon: Activity },
  { id: 'results', label: 'Results', icon: FileOutput },
  { id: 'inference', label: 'Inference', icon: Terminal },
]

interface SidebarProps {
  activePage: PageId
  onNavigate: (page: PageId) => void
  currentRunId: string | null
  onSelectRun: (runId: string) => void
}

const STATUS_COLORS: Record<string, string> = {
  running: 'text-primary',
  completed: 'text-green-600/60',
  failed: 'text-red-500',
  queued: 'text-yellow-500',
}

export default function Sidebar({ activePage, onNavigate, currentRunId, onSelectRun }: SidebarProps) {
  const [runs, setRuns] = useState<RunSummary[]>([])

  const fetchRuns = useCallback(async () => {
    try {
      const data = await listRuns()
      setRuns(data)
    } catch {
      // ignore
    }
  }, [])

  useEffect(() => {
    fetchRuns()
    const interval = setInterval(fetchRuns, 10_000)
    return () => clearInterval(interval)
  }, [fetchRuns])

  return (
    <aside className="w-56 h-full border-r border-border/50/50 bg-sidebar/70 backdrop-blur-sm flex flex-col shrink-0 overflow-hidden">
      <div className="p-4 border-b border-border/50">
        <h1 className="text-lg font-bold text-foreground">Autodistil-KG</h1>
        <p className="text-xs text-muted-foreground">Pipeline Manager</p>
      </div>

      <nav className="flex-1 py-2">
        {NAV_ITEMS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => onNavigate(id)}
            className={`w-full flex items-center gap-3 px-4 py-2.5 text-sm transition-colors ${
              activePage === id
                ? 'bg-primary/10 text-primary border-r-2 border-primary font-medium'
                : 'text-muted-foreground hover:text-foreground hover:bg-accent'
            }`}
          >
            <Icon className="w-4 h-4" />
            {label}
          </button>
        ))}
      </nav>

      <div className="border-t border-border/50">
        <div className="flex items-center gap-2 px-4 py-2 text-xs font-medium text-muted-foreground uppercase tracking-wider">
          <History className="w-3 h-3" />
          Run History
        </div>
        <div className="max-h-48 overflow-y-auto pb-2">
          {runs.length === 0 && (
            <p className="px-4 py-2 text-xs text-muted-foreground">No runs yet</p>
          )}
          {runs.slice(0, 20).map((run) => (
            <button
              key={run.run_id}
              onClick={() => onSelectRun(run.run_id)}
              className={`w-full flex items-center gap-2 px-4 py-1.5 text-xs transition-colors ${
                currentRunId === run.run_id
                  ? 'bg-accent text-foreground'
                  : 'text-muted-foreground hover:text-foreground hover:bg-accent/50'
              }`}
            >
              <Circle className={`w-2 h-2 fill-current ${STATUS_COLORS[run.status] ?? 'text-gray-400'}`} />
              <span className="truncate font-mono">{run.run_id.slice(0, 8)}</span>
              <span className="ml-auto text-[10px] capitalize">{run.status}</span>
            </button>
          ))}
        </div>
      </div>
    </aside>
  )
}
