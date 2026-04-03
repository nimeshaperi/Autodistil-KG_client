<<<<<<< HEAD
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
=======
import { Database, FileText, Cpu, BarChart3, Play, Upload, Download, ChevronRight, MessageSquare } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'
import type { StageId } from '@/types/config'
import { STAGE_ORDER, STAGE_LABELS } from '@/types/config'

const STAGE_ICONS: Record<StageId, React.ReactNode> = {
  graph_traverser: <Database className="h-4 w-4" />,
  chatml_converter: <FileText className="h-4 w-4" />,
  finetuner: <Cpu className="h-4 w-4" />,
  evaluator: <BarChart3 className="h-4 w-4" />,
}

interface RunSummary {
  run_id: string
  status: string
}

interface SidebarProps {
  selectedStages: StageId[]
  onToggleStage: (id: StageId) => void
  activeView: string | null
  onSelectView: (view: string | null) => void
  stageStatuses: Record<string, 'pending' | 'running' | 'completed' | 'failed'>
  onRun: () => void
  onImport: () => void
  onExport: () => void
  running: boolean
  runs: RunSummary[]
  activeRunId: string | null
>>>>>>> 3194a5a3cd2e312762d7a1e18bc34481382095f4
  onSelectRun: (runId: string) => void
}

const STATUS_COLORS: Record<string, string> = {
<<<<<<< HEAD
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
=======
  running: 'bg-blue-500',
  completed: 'bg-green-500',
  failed: 'bg-red-500',
  queued: 'bg-yellow-500',
  pending: 'bg-slate-300',
}

export default function Sidebar({
  selectedStages,
  onToggleStage,
  activeView,
  onSelectView,
  stageStatuses,
  onRun,
  onImport,
  onExport,
  running,
  runs,
  activeRunId,
  onSelectRun,
}: SidebarProps) {
  return (
    <aside className="w-64 shrink-0 bg-card border-r border-border flex flex-col h-screen sticky top-0">
      {/* Logo */}
      <div className="p-4 border-b border-border">
        <h1 className="text-lg font-bold text-foreground">Autodistil-KG</h1>
        <p className="text-xs text-muted-foreground mt-0.5">Knowledge Graph Pipeline</p>
      </div>

      {/* Stage navigation */}
      <div className="flex-1 overflow-y-auto">
        <div className="p-3">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2 px-1">
            Pipeline Stages
          </p>
          <div className="space-y-1">
            {STAGE_ORDER.map((id) => {
              const active = selectedStages.includes(id)
              const isSelected = activeView === id
              const status = stageStatuses[id] ?? 'pending'
              return (
                <div key={id} className="group">
                  <button
                    onClick={() => onSelectView(isSelected ? null : id)}
                    className={cn(
                      'w-full flex items-center gap-2.5 px-2.5 py-2 rounded-md text-left text-sm transition-colors',
                      isSelected
                        ? 'bg-primary/10 text-primary font-medium'
                        : 'hover:bg-muted text-foreground',
                      !active && 'opacity-50',
                    )}
                  >
                    <div className="flex items-center gap-2.5 flex-1 min-w-0">
                      <span className={cn(
                        'shrink-0',
                        isSelected ? 'text-primary' : 'text-muted-foreground',
                      )}>
                        {STAGE_ICONS[id]}
                      </span>
                      <div className="flex-1 min-w-0">
                        <span className="block truncate text-sm">{STAGE_LABELS[id]}</span>
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0" onClick={(e) => e.stopPropagation()}>
                      {status !== 'pending' && (
                        <span className={cn(
                          'w-2 h-2 rounded-full shrink-0',
                          STATUS_COLORS[status],
                          status === 'running' && 'animate-pulse',
                        )} />
                      )}
                      <Switch
                        checked={active}
                        onCheckedChange={() => onToggleStage(id)}
                        className="scale-75"
                      />
                    </div>
                  </button>
                </div>
              )
            })}
          </div>
        </div>

        {/* Overview & Playground buttons */}
        <div className="px-3 mb-2 space-y-1">
          <button
            onClick={() => onSelectView('overview')}
            className={cn(
              'w-full flex items-center gap-2.5 px-2.5 py-2 rounded-md text-left text-sm transition-colors',
              activeView === 'overview'
                ? 'bg-primary/10 text-primary font-medium'
                : 'hover:bg-muted text-muted-foreground',
            )}
          >
            <ChevronRight className="h-4 w-4" />
            <span>Overview & Logs</span>
          </button>
          <button
            onClick={() => onSelectView('playground')}
            className={cn(
              'w-full flex items-center gap-2.5 px-2.5 py-2 rounded-md text-left text-sm transition-colors',
              activeView === 'playground'
                ? 'bg-primary/10 text-primary font-medium'
                : 'hover:bg-muted text-muted-foreground',
            )}
          >
            <MessageSquare className="h-4 w-4" />
            <span>Model Playground</span>
          </button>
        </div>

        {/* Run History */}
        {runs.length > 0 && (
          <div className="p-3 border-t border-border">
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2 px-1">
              Recent Runs
            </p>
            <div className="space-y-1 max-h-36 overflow-y-auto">
              {runs.slice(0, 8).map((run) => (
                <button
                  key={run.run_id}
                  onClick={() => onSelectRun(run.run_id)}
                  className={cn(
                    'w-full flex items-center gap-2 px-2.5 py-1.5 rounded-md text-left text-xs transition-colors',
                    activeRunId === run.run_id
                      ? 'bg-primary/10 text-primary'
                      : 'hover:bg-muted text-muted-foreground',
                  )}
                >
                  <span className={cn('w-2 h-2 rounded-full shrink-0', STATUS_COLORS[run.status] ?? 'bg-gray-400')} />
                  <span className="font-mono truncate flex-1">{run.run_id.slice(0, 8)}</span>
                  <span className="capitalize">{run.status}</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Bottom controls */}
      <div className="p-3 border-t border-border space-y-2">
        <div className="flex gap-1.5">
          <Button size="sm" variant="outline" onClick={onImport} className="flex-1 text-xs h-8">
            <Upload className="h-3.5 w-3.5" />
            Import
          </Button>
          <Button size="sm" variant="outline" onClick={onExport} className="flex-1 text-xs h-8">
            <Download className="h-3.5 w-3.5" />
            Export
          </Button>
        </div>
        <Button size="sm" onClick={onRun} disabled={running} className="w-full h-9">
          <Play className="h-4 w-4" />
          {running ? 'Running...' : 'Run Pipeline'}
        </Button>
>>>>>>> 3194a5a3cd2e312762d7a1e18bc34481382095f4
      </div>
    </aside>
  )
}
