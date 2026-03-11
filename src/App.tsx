import React, { useState, useCallback, useEffect, useRef, useMemo } from 'react'
import Sidebar from './components/Sidebar'
import ConfigurePipeline from './components/ConfigurePipeline'
import MonitorProgress from './components/MonitorProgress'
import ResultsOutput from './components/ResultsOutput'
import ModelPlayground from './components/ModelPlayground'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { ChevronDown } from 'lucide-react'
import type { PipelineConfigPayload, StageId } from './types/config'
import { STAGE_ORDER } from './types/config'
import type { WsEvent, RunSummary } from './api/client'
import { listRuns } from './api/client'

interface RunSession {
  runId: string
  config: PipelineConfigPayload | null
  wsEvents: WsEvent[]
  result: unknown
  isWsConnected: boolean | undefined
}

function emptySession(runId: string, config: PipelineConfigPayload | null = null): RunSession {
  return { runId, config, wsEvents: [], result: null, isWsConnected: undefined }
}

export default function App() {
  const [sessions, setSessions] = useState<Map<string, RunSession>>(new Map())
  const [activeRunId, setActiveRunId] = useState<string | null>(null)
  const [activeView, setActiveView] = useState<string | null>('graph_traverser')
  const [runs, setRuns] = useState<RunSummary[]>([])

  const activeSession = activeRunId ? sessions.get(activeRunId) : undefined

  // Pipeline config state (lifted from ConfigurePipeline for sidebar access)
  const [selectedStages, setSelectedStages] = useState<StageId[]>(['graph_traverser', 'chatml_converter'])
  const [running, setRunning] = useState(false)

  // Derive stage statuses from active session's events
  const stageStatuses = useMemo(() => {
    const statuses: Record<string, 'pending' | 'running' | 'completed' | 'failed'> = {}
    const events = activeSession?.wsEvents ?? []
    for (const ev of events) {
      if (ev.event === 'stage_start') {
        statuses[ev.stage] = 'running'
      } else if (ev.event === 'stage_end') {
        statuses[ev.stage] = ev.success ? 'completed' : 'failed'
      }
    }
    return statuses
  }, [activeSession?.wsEvents])

  // Fetch recent runs
  useEffect(() => {
    const fetch = () => listRuns().then(setRuns).catch(() => {})
    fetch()
    const interval = setInterval(fetch, 10_000)
    return () => clearInterval(interval)
  }, [])

  const handleRun = useCallback((runId: string, cfg: PipelineConfigPayload) => {
    setSessions((prev) => {
      const next = new Map(prev)
      next.set(runId, emptySession(runId, cfg))
      return next
    })
    setActiveRunId(runId)
    setActiveView('overview')
  }, [])

  const handleDone = useCallback((result: unknown) => {
    setActiveRunId((currentId) => {
      if (currentId) {
        setSessions((prev) => {
          const next = new Map(prev)
          const s = next.get(currentId)
          if (s) next.set(currentId, { ...s, result })
          return next
        })
      }
      return currentId
    })
  }, [])

  const setWsEvents = useCallback((updater: WsEvent[] | ((prev: WsEvent[]) => WsEvent[])) => {
    setActiveRunId((currentId) => {
      if (currentId) {
        setSessions((prev) => {
          const next = new Map(prev)
          const s = next.get(currentId)
          if (s) {
            const newEvents = typeof updater === 'function' ? updater(s.wsEvents) : updater
            next.set(currentId, { ...s, wsEvents: newEvents })
          }
          return next
        })
      }
      return currentId
    })
  }, [])

  const setIsConnected: React.Dispatch<React.SetStateAction<boolean | undefined>> = useCallback(
    (value: React.SetStateAction<boolean | undefined>) => {
      setActiveRunId((currentId) => {
        if (currentId) {
          setSessions((prev) => {
            const next = new Map(prev)
            const s = next.get(currentId)
            if (s) {
              const resolved = typeof value === 'function' ? value(s.isWsConnected) : value
              next.set(currentId, { ...s, isWsConnected: resolved })
            }
            return next
          })
        }
        return currentId
      })
    }, []
  )

  const handleSelectRun = useCallback((runId: string) => {
    if (!sessions.has(runId)) {
      setSessions((prev) => {
        const next = new Map(prev)
        next.set(runId, emptySession(runId))
        return next
      })
    }
    setActiveRunId(runId)
    setActiveView('overview')
  }, [sessions])

  const toggleStage = useCallback((id: StageId) => {
    setSelectedStages((prev) =>
      prev.includes(id) ? prev.filter((s) => s !== id) : [...prev, id]
    )
  }, [])

  // File import ref
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Determine what to show in main content
  const isStageView = activeView && STAGE_ORDER.includes(activeView as StageId)
  const isOverview = activeView === 'overview'
  const isPlayground = activeView === 'playground'

  return (
    <div className="flex min-h-screen bg-[#f5f8fa]">
      <Sidebar
        selectedStages={selectedStages}
        onToggleStage={toggleStage}
        activeView={activeView}
        onSelectView={setActiveView}
        stageStatuses={stageStatuses}
        onRun={() => {
          // Trigger run via ConfigurePipeline's ref
          const btn = document.getElementById('pipeline-run-trigger')
          if (btn) btn.click()
        }}
        onImport={() => fileInputRef.current?.click()}
        onExport={() => {
          const btn = document.getElementById('pipeline-export-trigger')
          if (btn) btn.click()
        }}
        running={running}
        runs={runs}
        activeRunId={activeRunId}
        onSelectRun={handleSelectRun}
      />

      <main className="flex-1 min-w-0 overflow-y-auto h-screen">
        <div className="max-w-4xl mx-auto px-6 py-6 space-y-6">
          {/* Hidden config component that manages all state + run logic */}
          <ConfigurePipeline
            onRun={handleRun}
            setWsEvents={setWsEvents}
            setIsConnected={setIsConnected}
            onDone={handleDone}
            fileInputRef={fileInputRef}
            selectedStages={selectedStages}
            setSelectedStages={setSelectedStages}
            activeStageView={isStageView ? (activeView as StageId) : null}
            running={running}
            setRunning={setRunning}
          />

          {/* Stage-specific monitoring */}
          {isStageView && activeRunId && (
            <SectionCollapsible title="Monitoring" defaultOpen>
              <MonitorProgress
                runId={activeRunId}
                config={activeSession?.config ?? null}
                wsEvents={activeSession?.wsEvents ?? []}
                isConnected={activeSession?.isWsConnected}
                onDone={handleDone}
                stageFilter={activeView as StageId}
              />
            </SectionCollapsible>
          )}

          {/* Stage-specific results */}
          {isStageView && activeSession?.result != null && (
            <SectionCollapsible title="Results" defaultOpen>
              <ResultsOutput
                runId={activeRunId}
                result={activeSession.result}
                onRefresh={() => setActiveView('overview')}
                stageFilter={activeView as StageId}
              />
            </SectionCollapsible>
          )}

          {/* Overview view: full monitoring + results */}
          {isOverview && (
            <>
              {activeRunId && (
                <MonitorProgress
                  runId={activeRunId}
                  config={activeSession?.config ?? null}
                  wsEvents={activeSession?.wsEvents ?? []}
                  isConnected={activeSession?.isWsConnected}
                  onDone={handleDone}
                />
              )}
              {activeSession?.result != null && (
                <ResultsOutput
                  runId={activeRunId}
                  result={activeSession.result}
                  onRefresh={() => {}}
                />
              )}
              {!activeRunId && (
                <div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
                  <p className="text-lg font-medium">No active run</p>
                  <p className="text-sm mt-1">Select a stage from the sidebar to configure, then run the pipeline.</p>
                </div>
              )}
            </>
          )}

          {/* Model Playground */}
          {isPlayground && <ModelPlayground />}

          {/* Default: no view selected */}
          {!activeView && (
            <div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
              <p className="text-lg font-medium">Select a stage</p>
              <p className="text-sm mt-1">Click a pipeline stage in the sidebar to configure it.</p>
            </div>
          )}
        </div>
      </main>
    </div>
  )
}

function SectionCollapsible({
  title,
  children,
  defaultOpen = true,
}: {
  title: string
  children: React.ReactNode
  defaultOpen?: boolean
}) {
  return (
    <Collapsible defaultOpen={defaultOpen}>
      <CollapsibleTrigger className="flex w-full items-center gap-2 py-2 text-left font-semibold text-sm text-muted-foreground uppercase tracking-wider hover:text-foreground [&[data-state=open]>svg]:rotate-180">
        {title}
        <ChevronDown className="h-4 w-4 ml-auto transition-transform" />
      </CollapsibleTrigger>
      <CollapsibleContent>
        {children}
      </CollapsibleContent>
    </Collapsible>
  )
}
