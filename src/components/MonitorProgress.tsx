import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { FileText, Clock, AlertTriangle, Wifi, WifiOff } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Progress } from '@/components/ui/progress'
import { Badge } from '@/components/ui/badge'
import { getRunStatus } from '@/api/client'
import type { WsEvent } from '@/api/client'
import type { PipelineConfigPayload } from '@/types/config'
import { STAGE_LABELS } from '@/types/config'

function stagesFromWsEvents(events: WsEvent[], runOrder: string[]): { stages: StageDetail[]; overallProgress: number; logs: string[] } {
  let orderedStages = runOrder
  let stageDetails: StageDetail[] = runOrder.map((id) => ({
    name: STAGE_LABELS[id as keyof typeof STAGE_LABELS] ?? id,
    status: 'pending' as const,
    progress: 0,
  }))
  const logs: string[] = []
  let completedCount = 0

  for (const ev of events) {
    const ts = new Date().toISOString().slice(11, 19)
    if (ev.event === 'run_start') {
      logs.push(`[${ts}] [INFO] Run started (live updates via WebSocket)`)
      continue
    }
    if (ev.event === 'pipeline_start') {
      orderedStages = ev.stages ?? runOrder
      stageDetails = orderedStages.map((id) => ({
        name: STAGE_LABELS[id as keyof typeof STAGE_LABELS] ?? id,
        status: 'pending' as const,
        progress: 0,
      }))
      logs.push(`[${ts}] [INFO] Pipeline started: ${orderedStages.join(' → ')}`)
      continue
    }
    if (ev.event === 'stage_start') {
      const idx = orderedStages.indexOf(ev.stage)
      if (idx >= 0 && idx < stageDetails.length) {
        stageDetails[idx] = {
          ...stageDetails[idx],
          name: STAGE_LABELS[ev.stage as keyof typeof STAGE_LABELS] ?? ev.stage,
          status: 'running',
          progress: 0,
        }
      }
      logs.push(`[${ts}] [INFO] Stage started: ${ev.stage}`)
      continue
    }
    if (ev.event === 'stage_end') {
      const idx = orderedStages.indexOf(ev.stage)
      if (idx >= 0 && idx < stageDetails.length) {
        stageDetails[idx] = {
          ...stageDetails[idx],
          name: STAGE_LABELS[ev.stage as keyof typeof STAGE_LABELS] ?? ev.stage,
          status: ev.success ? 'completed' : 'failed',
          progress: ev.success ? 100 : 0,
          error: ev.error,
        }
        if (ev.success) completedCount++
      }
      const level = ev.success ? 'INFO' : 'ERROR'
      logs.push(`[${ts}] [${level}] Stage ${ev.success ? 'completed' : 'failed'}: ${ev.stage}${ev.error ? ` — ${ev.error}` : ''}`)
      continue
    }
    if (ev.event === 'log') {
      // Handle streaming log events from the pipeline
      const logEvent = ev as { event: 'log'; level: string; logger: string; message: string }
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

interface StageDetail {
  name: string
  status: 'pending' | 'running' | 'completed' | 'failed'
  progress: number
  error?: string
}

function formatPhase(res: { status: string; current_stage?: string; stages?: string[] }): string {
  const labels = (res.stages ?? []).map((s) => STAGE_LABELS[s as keyof typeof STAGE_LABELS] ?? s)
  const phaseName = res.current_stage
    ? (STAGE_LABELS[res.current_stage as keyof typeof STAGE_LABELS] ?? res.current_stage)
    : null
  if (res.status === 'running') {
    if (phaseName) return `Phase: Running — ${phaseName}${labels.length ? ` (${labels.join(' → ')})` : ''}`
    return `Phase: Running${labels.length ? ` — ${labels.join(' → ')}` : ''}`
  }
  if (res.status === 'completed') return 'Phase: Completed'
  if (res.status === 'failed') return 'Phase: Failed'
  return `Status: ${res.status}`
}

interface MonitorProgressProps {
  runId: string | null
  config: PipelineConfigPayload | null
  wsEvents?: WsEvent[]
  isConnected?: boolean
  onDone: (result: unknown) => void
}

export default function MonitorProgress({ runId, config, wsEvents = [], isConnected, onDone }: MonitorProgressProps) {
  const [stages, setStages] = useState<StageDetail[]>([])
  const [overallProgress, setOverallProgress] = useState(0)
  const [logs, setLogs] = useState<string[]>([])
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const addLog = useCallback((msg: string) => {
    setLogs((prev) => [...prev, `${new Date().toISOString().slice(11, 19)} ${msg}`])
  }, [])

  const runOrder = config?.run_stages ?? []
  const lastLogMsgRef = useRef<string | null>(null)

  const useLiveEvents = wsEvents.length > 0
  const liveDerived = useMemo(() => {
    if (!useLiveEvents || runOrder.length === 0) return null
    return stagesFromWsEvents(wsEvents, runOrder)
  }, [useLiveEvents, wsEvents, runOrder])

  useEffect(() => {
    if (!runId || runOrder.length === 0) {
      setStages(
        runOrder.map((id) => ({
          name: STAGE_LABELS[id] ?? id,
          status: 'pending' as const,
          progress: 0,
        }))
      )
      setOverallProgress(0)
      setLogs([])
      lastLogMsgRef.current = null
      return
    }

    if (useLiveEvents) return

    addLog(`Watching run ${runId}. Polling for status...`)
    lastLogMsgRef.current = null

    pollRef.current = setInterval(async () => {
      try {
        const res = await getRunStatus(runId)
        const phaseMsg = formatPhase(res)
        const completed = (res.results ?? []).filter((r) => r.success).length
        const total = Math.max((res.results ?? []).length, res.stages?.length ?? 0, 1)
        const logMsg =
          res.status === 'running'
            ? `Poll: status=running — ${phaseMsg} (${completed}/${total} stages)`
            : `Poll: status=${res.status} — ${phaseMsg} (${completed}/${total} stages)`
        if (logMsg !== lastLogMsgRef.current) {
          lastLogMsgRef.current = logMsg
          addLog(logMsg)
        }

        if (res.status === 'running') return
        if (res.status === 'completed' || res.status === 'failed') {
          if (pollRef.current) {
            clearInterval(pollRef.current)
            pollRef.current = null
          }
          setStages(
            (res.results ?? []).map((r, i) => ({
              name: STAGE_LABELS[runOrder[i] as keyof typeof STAGE_LABELS] ?? runOrder[i],
              status: r.success ? 'completed' : 'failed',
              progress: r.success ? 100 : 0,
              error: r.error,
            }))
          )
          setOverallProgress(
            res.status === 'completed'
              ? 100
              : Math.round(
                  ((res.results ?? []).filter((r) => r.success).length / (res.results?.length ?? 1)) * 100
                )
          )
          addLog(
            res.status === 'completed'
              ? 'Pipeline completed.'
              : `Pipeline failed: ${res.error ?? 'Unknown'}`
          )
          onDone(res)
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'Unknown'
        addLog(`Poll error: ${msg}`)
      }
    }, 2000)

    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current)
        pollRef.current = null
      }
    }
  }, [runId, runOrder, onDone, addLog, useLiveEvents])

  const displayStages: StageDetail[] = liveDerived
    ? liveDerived.stages
    : stages.length > 0
      ? stages
      : runOrder.map((id) => ({
          name: STAGE_LABELS[id] ?? id,
          status: 'pending' as const,
          progress: 0,
        }))

  const displayProgress = liveDerived ? liveDerived.overallProgress : overallProgress
  const displayLogs = liveDerived ? liveDerived.logs : logs
  const completedCount = displayStages.filter((s) => s.status === 'completed').length

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle>Overall Progress</CardTitle>
            {isConnected !== undefined && (
              <div className={`flex items-center gap-1.5 text-xs px-2 py-1 rounded-full ${isConnected ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400' : 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400'}`}>
                {isConnected ? <Wifi className="h-3 w-3" /> : <WifiOff className="h-3 w-3" />}
                {isConnected ? 'Live' : 'Disconnected'}
              </div>
            )}
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

      <Card>
        <CardHeader>
          <CardTitle>Stage Details</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {displayStages.map((stage) => (
            <div
              key={stage.name}
              className="flex items-start gap-4 p-4 rounded-lg border bg-muted/30"
            >
              <FileText className="h-5 w-5 text-muted-foreground shrink-0 mt-0.5" />
              <div className="flex-1 min-w-0">
                <h3 className="font-medium">{stage.name}</h3>
                <Badge
                  variant={
                    stage.status === 'completed'
                      ? 'default'
                      : stage.status === 'failed'
                        ? 'destructive'
                        : 'secondary'
                  }
                  className="mt-1"
                >
                  {stage.status}
                </Badge>
                <p className="text-sm text-muted-foreground mt-2">Progress</p>
                <div className="flex items-center gap-2 mt-1">
                  <Progress value={stage.progress} className="flex-1 h-1.5" />
                  <span className="text-xs text-muted-foreground w-8">{stage.progress}%</span>
                </div>
                {'error' in stage && stage.error && (
                  <p className="text-sm text-destructive mt-2">{stage.error}</p>
                )}
              </div>
              <Clock className="h-4 w-4 text-muted-foreground shrink-0" />
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Execution Logs</CardTitle>
        </CardHeader>
        <CardContent>
          {displayLogs.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
              <AlertTriangle className="h-10 w-10" />
              <p className="text-sm mt-2">No logs yet. Start the pipeline to see execution details.</p>
            </div>
          ) : (
            <pre className="text-xs font-mono rounded-md border bg-muted/50 p-3 max-h-48 overflow-y-auto">
              {displayLogs.join('\n')}
            </pre>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
