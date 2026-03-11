import { useEffect, useMemo, useRef, useState } from 'react'
import { FileText, Clock, AlertTriangle, Wifi, WifiOff, CheckCircle2, XCircle, Loader2 } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Progress } from '@/components/ui/progress'
import { Badge } from '@/components/ui/badge'
import { getRunStatus, getRunEvents } from '@/api/client'
import type { WsEvent, RunResultResponse } from '@/api/client'
import type { PipelineConfigPayload } from '@/types/config'
import { STAGE_LABELS } from '@/types/config'
import TraversalActivity from './TraversalActivity'
import GraphVisualization from './GraphVisualization'

/* ------------------------------------------------------------------ */
/*  Derive stage state from a stream of WsEvents                      */
/* ------------------------------------------------------------------ */

function stagesFromWsEvents(events: WsEvent[], fallbackOrder: string[]): { stages: StageDetail[]; overallProgress: number; logs: string[] } {
  let orderedStages = fallbackOrder
  let stageDetails: StageDetail[] = fallbackOrder.map((id) => ({
    id,
    name: STAGE_LABELS[id as keyof typeof STAGE_LABELS] ?? id,
    status: 'pending' as const,
    progress: 0,
  }))
  const logs: string[] = []
  let completedCount = 0

  for (const ev of events) {
    const ts = new Date().toISOString().slice(11, 19)
    if (ev.event === 'run_start') {
      logs.push(`[${ts}] [INFO] Run started`)
      continue
    }
    if (ev.event === 'pipeline_start') {
      orderedStages = ev.stages ?? fallbackOrder
      stageDetails = orderedStages.map((id) => ({
        id,
        name: STAGE_LABELS[id as keyof typeof STAGE_LABELS] ?? id,
        status: 'pending' as const,
        progress: 0,
      }))
      logs.push(`[${ts}] [INFO] Pipeline started: ${orderedStages.join(' \u2192 ')}`)
      continue
    }
    if (ev.event === 'stage_start') {
      const idx = orderedStages.indexOf(ev.stage)
      if (idx >= 0 && idx < stageDetails.length) {
        stageDetails[idx] = { ...stageDetails[idx], status: 'running', progress: 0 }
      }
      logs.push(`[${ts}] [INFO] Stage started: ${ev.stage}`)
      continue
    }
    if (ev.event === 'stage_end') {
      const idx = orderedStages.indexOf(ev.stage)
      if (idx >= 0 && idx < stageDetails.length) {
        stageDetails[idx] = {
          ...stageDetails[idx],
          status: ev.success ? 'completed' : 'failed',
          progress: ev.success ? 100 : 0,
          error: ev.error,
        }
        if (ev.success) completedCount++
      }
      const level = ev.success ? 'INFO' : 'ERROR'
      logs.push(`[${ts}] [${level}] Stage ${ev.success ? 'completed' : 'failed'}: ${ev.stage}${ev.error ? ` \u2014 ${ev.error}` : ''}`)
      continue
    }
    if (ev.event === 'traversal_progress') continue
    if (ev.event === 'log') {
      const logEvent = ev as { event: 'log'; level: string; logger: string; message: string }
      if (logEvent.message.startsWith('traversal:')) continue
      logs.push(`[${ts}] [${logEvent.level}] ${logEvent.message}`)
      continue
    }
    if (ev.event === 'done') {
      const level = ev.success ? 'INFO' : 'ERROR'
      logs.push(`[${ts}] [${level}] Pipeline ${ev.success ? 'completed successfully.' : 'failed.'}`)
      continue
    }
    if (ev.event === 'error') {
      logs.push(`[${ts}] [ERROR] ${ev.message}`)
    }
  }

  const total = stageDetails.length || 1
  const overallProgress = total ? Math.round((completedCount / total) * 100) : 0
  const lastEv = events[events.length - 1]
  if (lastEv?.event === 'done' && (lastEv as { success?: boolean }).success) {
    return { stages: stageDetails, overallProgress: 100, logs }
  }
  return { stages: stageDetails, overallProgress, logs }
}

/* ------------------------------------------------------------------ */
/*  Synthesize stage details from REST status (fallback when no events)*/
/* ------------------------------------------------------------------ */

function stagesFromRunStatus(status: RunResultResponse): StageDetail[] {
  const stageOrder = status.stages ?? []
  const results = status.results ?? []
  const currentStage = status.current_stage

  return stageOrder.map((id, idx) => {
    const result = results[idx]
    let stageStatus: StageDetail['status'] = 'pending'
    let progress = 0
    let error: string | undefined

    if (result) {
      stageStatus = result.success ? 'completed' : 'failed'
      progress = result.success ? 100 : 0
      error = result.error
    } else if (currentStage === id) {
      stageStatus = 'running'
      progress = 0
    } else if (currentStage) {
      // If there's a current stage, stages before it (that have no result) are completed
      const currentIdx = stageOrder.indexOf(currentStage)
      if (currentIdx >= 0 && idx < currentIdx) {
        stageStatus = 'completed'
        progress = 100
      }
    }

    return {
      id,
      name: STAGE_LABELS[id as keyof typeof STAGE_LABELS] ?? id,
      status: stageStatus,
      progress,
      error,
    }
  })
}

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface StageDetail {
  id?: string
  name: string
  status: 'pending' | 'running' | 'completed' | 'failed'
  progress: number
  error?: string
}

interface MonitorProgressProps {
  runId: string | null
  config: PipelineConfigPayload | null
  wsEvents?: WsEvent[]
  isConnected?: boolean
  onDone: (result: unknown) => void
  /** When set, only show monitoring for this specific stage */
  stageFilter?: string
}

/* ------------------------------------------------------------------ */
/*  Stage status icon helper                                           */
/* ------------------------------------------------------------------ */

function StageStatusIcon({ status }: { status: StageDetail['status'] }) {
  switch (status) {
    case 'completed':
      return <CheckCircle2 className="h-5 w-5 text-green-500 shrink-0" />
    case 'failed':
      return <XCircle className="h-5 w-5 text-red-500 shrink-0" />
    case 'running':
      return <Loader2 className="h-5 w-5 text-blue-500 shrink-0 animate-spin" />
    default:
      return <FileText className="h-5 w-5 text-muted-foreground shrink-0" />
  }
}

/* ------------------------------------------------------------------ */
/*  Main component                                                     */
/* ------------------------------------------------------------------ */

export default function MonitorProgress({ runId, config, wsEvents = [], isConnected, onDone, stageFilter }: MonitorProgressProps) {
  const [polledEvents, setPolledEvents] = useState<WsEvent[]>([])
  const [polledStages, setPolledStages] = useState<string[]>([])
  const [runStatus, setRunStatus] = useState<string | null>(null)
  // Fallback: stage details derived directly from REST status (when events are unavailable)
  const [statusDerivedStages, setStatusDerivedStages] = useState<StageDetail[]>([])
  const [statusDerivedLogs, setStatusDerivedLogs] = useState<string[]>([])
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const eventCursorRef = useRef(0)
  const lastStatusLogRef = useRef<string | null>(null)

  const runOrder = config?.run_stages ?? polledStages
  const hasLiveEvents = wsEvents.length > 0

  const effectiveEvents = hasLiveEvents ? wsEvents : polledEvents

  // Derive stage details from events (when we have them)
  const eventDerived = useMemo(() => {
    if (effectiveEvents.length === 0 && runOrder.length === 0) return null
    if (effectiveEvents.length === 0) return null
    return stagesFromWsEvents(effectiveEvents, runOrder)
  }, [effectiveEvents, runOrder])

  // Poll for events and status when we don't have live WS events
  useEffect(() => {
    if (!runId || hasLiveEvents) {
      if (hasLiveEvents) {
        setPolledEvents([])
        setPolledStages([])
        setStatusDerivedStages([])
        setStatusDerivedLogs([])
        eventCursorRef.current = 0
        lastStatusLogRef.current = null
      }
      return
    }

    let cancelled = false

    const fetchData = async () => {
      try {
        const status = await getRunStatus(runId)
        if (cancelled) return
        setRunStatus(status.status)
        if (status.stages && status.stages.length > 0) {
          setPolledStages(status.stages)
        }

        // Always derive stages from status as a fallback
        if (status.stages && status.stages.length > 0) {
          setStatusDerivedStages(stagesFromRunStatus(status))
          // Add a log entry for the current state
          const currentLabel = status.current_stage
            ? (STAGE_LABELS[status.current_stage as keyof typeof STAGE_LABELS] ?? status.current_stage)
            : null
          const completedCount = (status.results ?? []).filter((r) => r.success).length
          const totalCount = status.stages.length
          const ts = new Date().toISOString().slice(11, 19)
          let logMsg: string
          if (status.status === 'running' && currentLabel) {
            logMsg = `[${ts}] [INFO] Running stage: ${currentLabel} (${completedCount}/${totalCount} completed)`
          } else if (status.status === 'completed') {
            logMsg = `[${ts}] [INFO] Pipeline completed (${completedCount}/${totalCount} stages)`
          } else if (status.status === 'failed') {
            logMsg = `[${ts}] [ERROR] Pipeline failed: ${status.error ?? 'unknown error'}`
          } else {
            logMsg = `[${ts}] [INFO] Status: ${status.status}`
          }
          if (logMsg !== lastStatusLogRef.current) {
            lastStatusLogRef.current = logMsg
            setStatusDerivedLogs((prev) => [...prev, logMsg])
          }
        }

        // Try to fetch events (may fail on older API versions)
        try {
          const evtRes = await getRunEvents(runId, eventCursorRef.current)
          if (cancelled) return
          if (evtRes.events.length > 0) {
            setPolledEvents((prev) => [...prev, ...evtRes.events])
            eventCursorRef.current = evtRes.total
          }
        } catch {
          // /events endpoint not available — rely on status-derived stages
        }

        if (status.status === 'completed' || status.status === 'failed') {
          onDone(status)
        }
      } catch {
        // Ignore fetch errors — run might not be registered yet
      }
    }

    // Reset state for new run
    setPolledEvents([])
    setPolledStages([])
    setStatusDerivedStages([])
    setStatusDerivedLogs([])
    setRunStatus(null)
    eventCursorRef.current = 0
    lastStatusLogRef.current = null

    fetchData()

    pollRef.current = setInterval(async () => {
      if (cancelled) return
      await fetchData()
      // Stop polling once done
      const currentStatus = await getRunStatus(runId).catch(() => null)
      if (currentStatus && (currentStatus.status === 'completed' || currentStatus.status === 'failed')) {
        if (pollRef.current) {
          clearInterval(pollRef.current)
          pollRef.current = null
        }
      }
    }, 2000)

    return () => {
      cancelled = true
      if (pollRef.current) {
        clearInterval(pollRef.current)
        pollRef.current = null
      }
    }
  }, [runId, hasLiveEvents, onDone])

  // Priority: event-derived > status-derived > empty
  const displayStages: StageDetail[] = eventDerived
    ? eventDerived.stages
    : statusDerivedStages.length > 0
      ? statusDerivedStages
      : runOrder.map((id) => ({
          id,
          name: STAGE_LABELS[id as keyof typeof STAGE_LABELS] ?? id,
          status: 'pending' as const,
          progress: 0,
        }))

  const displayProgress = eventDerived
    ? eventDerived.overallProgress
    : statusDerivedStages.length > 0
      ? Math.round((statusDerivedStages.filter((s) => s.status === 'completed').length / (statusDerivedStages.length || 1)) * 100)
      : 0
  const displayLogs = eventDerived ? eventDerived.logs : statusDerivedLogs
  const completedCount = displayStages.filter((s) => s.status === 'completed').length

  // When filtering for a specific stage, show only relevant content
  const filteredStage = stageFilter
    ? displayStages.find((s) => s.id === stageFilter)
    : null

  if (stageFilter) {
    return (
      <div className="space-y-4">
        {/* Stage-specific progress */}
        {filteredStage && (
          <div
            className={`flex items-start gap-4 p-4 rounded-lg border transition-all duration-300 ${
              filteredStage.status === 'running'
                ? 'border-blue-300 bg-blue-50/50 dark:bg-blue-950/20 shadow-sm'
                : filteredStage.status === 'completed'
                  ? 'border-green-200 bg-green-50/30 dark:bg-green-950/10'
                  : filteredStage.status === 'failed'
                    ? 'border-red-200 bg-red-50/30 dark:bg-red-950/10'
                    : 'bg-muted/30'
            }`}
          >
            <StageStatusIcon status={filteredStage.status} />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <h3 className="font-medium">{filteredStage.name}</h3>
                <Badge
                  variant={
                    filteredStage.status === 'completed' ? 'default'
                      : filteredStage.status === 'failed' ? 'destructive'
                        : filteredStage.status === 'running' ? 'secondary' : 'outline'
                  }
                  className={`text-xs ${filteredStage.status === 'running' ? 'animate-pulse' : ''}`}
                >
                  {filteredStage.status}
                </Badge>
                {isConnected !== undefined && (
                  <div className={`flex items-center gap-1 text-xs px-1.5 py-0.5 rounded-full ml-auto ${isConnected ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>
                    {isConnected ? <Wifi className="h-3 w-3" /> : <WifiOff className="h-3 w-3" />}
                    {isConnected ? 'Live' : 'Offline'}
                  </div>
                )}
              </div>
              {filteredStage.status !== 'pending' && (
                <div className="flex items-center gap-2 mt-2">
                  <Progress value={filteredStage.progress} className="flex-1 h-1.5" />
                  <span className="text-xs text-muted-foreground w-8">{filteredStage.progress}%</span>
                </div>
              )}
              {filteredStage.error && (
                <p className="text-sm text-destructive mt-2">{filteredStage.error}</p>
              )}
            </div>
          </div>
        )}

        {/* Graph-traverser-specific: show graph viz and traversal activity */}
        {stageFilter === 'graph_traverser' && (
          <>
            <GraphVisualization wsEvents={effectiveEvents} />
            <TraversalActivity wsEvents={effectiveEvents} />
          </>
        )}

        {/* Filtered logs */}
        {displayLogs.length > 0 && (
          <pre className="text-xs font-mono rounded-md border bg-muted/50 p-3 max-h-48 overflow-y-auto whitespace-pre-wrap">
            {displayLogs.join('\n')}
          </pre>
        )}
      </div>
    )
  }

  // Full (unfiltered) view
  return (
    <div className="space-y-6">
      {/* -- Overall Progress -- */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle>Overall Progress</CardTitle>
            <div className="flex items-center gap-2">
              {isConnected !== undefined && (
                <div className={`flex items-center gap-1.5 text-xs px-2 py-1 rounded-full ${isConnected ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400' : 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400'}`}>
                  {isConnected ? <Wifi className="h-3 w-3" /> : <WifiOff className="h-3 w-3" />}
                  {isConnected ? 'Live' : 'Disconnected'}
                </div>
              )}
              {!isConnected && runStatus && (
                <Badge variant={runStatus === 'completed' ? 'default' : runStatus === 'failed' ? 'destructive' : 'secondary'} className="text-xs">
                  {runStatus}
                </Badge>
              )}
            </div>
          </div>
          <p className="text-sm text-muted-foreground">
            {completedCount} of {displayStages.length} stages completed
          </p>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-3">
            <Progress value={displayProgress} className="flex-1" />
            <span className="text-sm font-medium w-8">{displayProgress}%</span>
          </div>
        </CardContent>
      </Card>

      {/* -- Pipeline Stages -- */}
      <Card>
        <CardHeader>
          <CardTitle>Stage Details</CardTitle>
        </CardHeader>
        <CardContent>
          {displayStages.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
              <FileText className="h-8 w-8 mb-2" />
              <p className="text-sm">No stages configured. Start a pipeline run to see stage details.</p>
            </div>
          ) : (
            <div className="space-y-3">
              {displayStages.map((stage, idx) => (
                <div key={stage.id ?? stage.name}>
                  {idx > 0 && (
                    <div className="flex justify-center -mt-3 mb-1">
                      <div className={`w-0.5 h-4 ${
                        displayStages[idx - 1].status === 'completed' ? 'bg-green-300' : 'bg-border'
                      }`} />
                    </div>
                  )}
                  <div
                    className={`flex items-start gap-4 p-4 rounded-lg border transition-all duration-300 ${
                      stage.status === 'running'
                        ? 'border-blue-300 bg-blue-50/50 dark:bg-blue-950/20 shadow-sm'
                        : stage.status === 'completed'
                          ? 'border-green-200 bg-green-50/30 dark:bg-green-950/10'
                          : stage.status === 'failed'
                            ? 'border-red-200 bg-red-50/30 dark:bg-red-950/10'
                            : 'bg-muted/30'
                    }`}
                  >
                    <StageStatusIcon status={stage.status} />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <h3 className="font-medium">{stage.name}</h3>
                        <Badge
                          variant={
                            stage.status === 'completed'
                              ? 'default'
                              : stage.status === 'failed'
                                ? 'destructive'
                                : stage.status === 'running'
                                  ? 'secondary'
                                  : 'outline'
                          }
                          className={`text-xs ${stage.status === 'running' ? 'animate-pulse' : ''}`}
                        >
                          {stage.status}
                        </Badge>
                      </div>
                      {stage.status !== 'pending' && (
                        <div className="flex items-center gap-2 mt-2">
                          <Progress value={stage.progress} className="flex-1 h-1.5" />
                          <span className="text-xs text-muted-foreground w-8">{stage.progress}%</span>
                        </div>
                      )}
                      {stage.error && (
                        <p className="text-sm text-destructive mt-2">{stage.error}</p>
                      )}
                    </div>
                    <Clock className="h-4 w-4 text-muted-foreground shrink-0" />
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* -- Graph Visualization -- */}
      <GraphVisualization wsEvents={effectiveEvents} />

      {/* -- Traversal Activity -- */}
      <TraversalActivity wsEvents={effectiveEvents} />

      {/* -- Execution Logs -- */}
      <Card>
        <CardHeader>
          <CardTitle>Execution Logs</CardTitle>
        </CardHeader>
        <CardContent>
          {displayLogs.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
              <AlertTriangle className="h-10 w-10" />
              <p className="text-sm mt-2">
                {runId ? 'Waiting for logs...' : 'No logs yet. Start the pipeline to see execution details.'}
              </p>
            </div>
          ) : (
            <pre className="text-xs font-mono rounded-md border bg-muted/50 p-3 max-h-64 overflow-y-auto whitespace-pre-wrap">
              {displayLogs.join('\n')}
            </pre>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
