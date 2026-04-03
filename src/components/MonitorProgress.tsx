import { useEffect, useMemo, useRef, useState } from 'react'
import { FileText, AlertTriangle, Wifi, WifiOff, CheckCircle2, XCircle, Loader2, StopCircle, Cpu, BarChart3, GitBranch, FileCode } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Progress } from '@/components/ui/progress'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Accordion, AccordionItem, AccordionTrigger, AccordionContent } from '@/components/ui/accordion'
import { getRunStatus, getRunEvents } from '@/api/client'
import type { WsEvent, RunResultResponse, EvalProgressEvent, FinetunerProgressEvent } from '@/api/client'
import type { PipelineConfigPayload } from '@/types/config'
import { STAGE_LABELS } from '@/types/config'
import TraversalActivity from './TraversalActivity'
import GraphVisualization from './GraphVisualization'

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

interface SystemPredictionProgress {
  id: string
  label: string
  kind: string
  completed: number
  total: number
  status: 'pending' | 'running' | 'done'
}

interface EvalState {
  systems: SystemPredictionProgress[]
  currentSystem?: string
  phase?: 'predicting' | 'scoring'
  scoringIndex?: number
  scoringTotal?: number
  scorers?: string[]
  lastScores?: Record<string, Record<string, number | null>>
}

interface FinetunerState {
  phase?: 'loading_model' | 'loading_data' | 'preparing_data' | 'training' | 'saving'
  modelName?: string
  step?: number
  totalSteps?: number
  epoch?: number
  totalEpochs?: number
  loss?: number
  learningRate?: number
  trainSamples?: number
  evalSamples?: number
}

interface MonitorProgressProps {
  runId: string | null
  config: PipelineConfigPayload | null
  wsEvents?: WsEvent[]
  isConnected?: boolean
  onDone: (result: unknown) => void
  onStop?: () => void
}

/* ------------------------------------------------------------------ */
/*  Stage icon helper                                                  */
/* ------------------------------------------------------------------ */

const STAGE_ICONS: Record<string, React.ReactNode> = {
  graph_traverser: <GitBranch className="h-4 w-4" />,
  chatml_converter: <FileCode className="h-4 w-4" />,
  finetuner: <Cpu className="h-4 w-4" />,
  evaluator: <BarChart3 className="h-4 w-4" />,
}

function StageStatusIcon({ status }: { status: StageDetail['status'] }) {
  switch (status) {
    case 'completed':
      return <CheckCircle2 className="h-5 w-5 text-green-600/60 shrink-0" />
    case 'failed':
      return <XCircle className="h-5 w-5 text-red-500/60 shrink-0" />
    case 'running':
      return <Loader2 className="h-5 w-5 text-primary shrink-0 animate-spin" />
    default:
      return <FileText className="h-5 w-5 text-muted-foreground shrink-0" />
  }
}

/* ------------------------------------------------------------------ */
/*  Derive stage state from WsEvents                                   */
/* ------------------------------------------------------------------ */

function stagesFromWsEvents(
  events: WsEvent[],
  fallbackOrder: string[],
): { stages: StageDetail[]; overallProgress: number; logs: string[]; evalState: EvalState; finetunerState: FinetunerState } {
  let orderedStages = fallbackOrder
  let stageDetails: StageDetail[] = fallbackOrder.map((id) => ({
    id,
    name: STAGE_LABELS[id as keyof typeof STAGE_LABELS] ?? id,
    status: 'pending' as const,
    progress: 0,
  }))
  const logs: string[] = []
  let completedCount = 0
  const evalState: EvalState = { systems: [] }
  const finetunerState: FinetunerState = {}

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
      if (ev.stage === 'finetuner') {
        finetunerState.phase = 'loading_model'
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
      if (ev.stage === 'finetuner') finetunerState.phase = undefined
      const level = ev.success ? 'INFO' : 'ERROR'
      logs.push(`[${ts}] [${level}] Stage ${ev.success ? 'completed' : 'failed'}: ${ev.stage}${ev.error ? ` \u2014 ${ev.error}` : ''}`)
      continue
    }
    if (ev.event === 'traversal_progress') continue
    if (ev.event === 'eval_progress') {
      const evalEv = ev as EvalProgressEvent
      const ts2 = new Date().toISOString().slice(11, 19)
      if (evalEv.type === 'eval_start') {
        // Initialize all systems as pending
        const systems = (evalEv as any).systems as Array<{ id: string; label: string; kind: string }> | undefined
        if (systems) {
          evalState.systems = systems.map(s => ({
            id: s.id, label: s.label, kind: s.kind,
            completed: 0, total: 0, status: 'pending' as const,
          }))
        }
        logs.push(`[${ts2}] [INFO] Evaluation started`)
      } else if (evalEv.type === 'system_start') {
        evalState.currentSystem = evalEv.system_id
        evalState.phase = 'predicting'
        // Mark this system as running
        const sys = evalState.systems.find(s => s.id === evalEv.system_id)
        if (sys) {
          sys.status = 'running'
          sys.label = evalEv.label ?? sys.label
        }
        logs.push(`[${ts2}] [INFO] Evaluating system: ${evalEv.label ?? evalEv.system_id}`)
      } else if (evalEv.type === 'predictions_start') {
        const sys = evalState.systems.find(s => s.id === evalEv.system_id)
        if (sys) {
          sys.total = evalEv.total_samples ?? 0
        }
      } else if (evalEv.type === 'prediction_done') {
        evalState.phase = 'predicting'
        const sys = evalState.systems.find(s => s.id === evalEv.system_id)
        if (sys) {
          sys.completed = (evalEv.sample_index ?? 0) + 1
          sys.total = evalEv.total_samples ?? sys.total
        }
      } else if (evalEv.type === 'system_done') {
        const sys = evalState.systems.find(s => s.id === evalEv.system_id)
        if (sys) {
          sys.status = 'done'
          sys.completed = sys.total
        }
      } else if (evalEv.type === 'scoring_start') {
        evalState.phase = 'scoring'
        evalState.scorers = evalEv.scorers
        evalState.scoringIndex = 0
        evalState.scoringTotal = evalEv.total_samples
        logs.push(`[${ts2}] [INFO] Scoring started (${evalEv.scorers?.join(', ') ?? 'metrics'})`)
      } else if (evalEv.type === 'scoring_done') {
        evalState.lastScores = evalEv.scores
        evalState.scoringIndex = (evalEv.sample_index ?? 0) + 1
        evalState.scoringTotal = evalEv.total_samples
      } else if (evalEv.type === 'eval_complete') {
        evalState.phase = undefined
        logs.push(`[${ts2}] [INFO] Evaluation complete`)
      }
      // Update evaluator stage progress bar
      const evalIdx = orderedStages.indexOf('evaluator')
      if (evalIdx >= 0 && evalIdx < stageDetails.length && stageDetails[evalIdx].status === 'running') {
        if (evalState.phase === 'predicting') {
          // Predictions phase = 0-80% of progress, split across systems
          let totalDone = 0
          let totalSamples = 0
          for (const sys of evalState.systems) {
            totalDone += sys.completed
            totalSamples += sys.total || 0
          }
          if (totalSamples > 0) {
            const pct = Math.round((totalDone / totalSamples) * 80)
            stageDetails[evalIdx] = { ...stageDetails[evalIdx], progress: Math.min(pct, 80) }
          }
        } else if (evalState.phase === 'scoring' && evalState.scoringTotal) {
          const pct = 80 + Math.round(((evalState.scoringIndex ?? 0) / evalState.scoringTotal) * 20)
          stageDetails[evalIdx] = { ...stageDetails[evalIdx], progress: Math.min(pct, 99) }
        }
      }
      continue
    }
    if (ev.event === 'finetuner_progress') {
      const ftEv = ev as FinetunerProgressEvent
      const finetunerIdx = orderedStages.indexOf('finetuner')
      if (ftEv.type === 'loading_model') {
        finetunerState.phase = 'loading_model'
        finetunerState.modelName = ftEv.model_name
        if (finetunerIdx >= 0) stageDetails[finetunerIdx] = { ...stageDetails[finetunerIdx], progress: 5 }
      } else if (ftEv.type === 'model_loaded') {
        finetunerState.phase = 'loading_model'
        if (finetunerIdx >= 0) stageDetails[finetunerIdx] = { ...stageDetails[finetunerIdx], progress: 15 }
      } else if (ftEv.type === 'loading_data' || ftEv.type === 'preparing_data') {
        finetunerState.phase = 'preparing_data'
        finetunerState.trainSamples = ftEv.train_samples ?? finetunerState.trainSamples
        finetunerState.evalSamples = ftEv.eval_samples ?? finetunerState.evalSamples
        if (finetunerIdx >= 0) stageDetails[finetunerIdx] = { ...stageDetails[finetunerIdx], progress: 20 }
      } else if (ftEv.type === 'data_ready') {
        finetunerState.phase = 'preparing_data'
        finetunerState.trainSamples = ftEv.train_samples
        finetunerState.evalSamples = ftEv.eval_samples
        if (finetunerIdx >= 0) stageDetails[finetunerIdx] = { ...stageDetails[finetunerIdx], progress: 25 }
      } else if (ftEv.type === 'training_start') {
        finetunerState.phase = 'training'
        finetunerState.totalSteps = ftEv.total_steps
        finetunerState.totalEpochs = ftEv.total_epochs
        if (finetunerIdx >= 0) stageDetails[finetunerIdx] = { ...stageDetails[finetunerIdx], progress: 28 }
      } else if (ftEv.type === 'training_step') {
        finetunerState.phase = 'training'
        finetunerState.step = ftEv.step
        finetunerState.totalSteps = ftEv.total_steps ?? finetunerState.totalSteps
        finetunerState.epoch = ftEv.epoch
        finetunerState.totalEpochs = ftEv.total_epochs ?? finetunerState.totalEpochs
        finetunerState.loss = ftEv.loss ?? finetunerState.loss
        finetunerState.learningRate = ftEv.learning_rate ?? finetunerState.learningRate
        if (finetunerIdx >= 0 && finetunerState.totalSteps && finetunerState.totalSteps > 0) {
          const pct = 28 + Math.round(((ftEv.step ?? 0) / finetunerState.totalSteps) * 60)
          stageDetails[finetunerIdx] = { ...stageDetails[finetunerIdx], progress: Math.min(pct, 88) }
        }
      } else if (ftEv.type === 'epoch_done') {
        finetunerState.epoch = ftEv.epoch
        finetunerState.totalEpochs = ftEv.total_epochs ?? finetunerState.totalEpochs
      } else if (ftEv.type === 'training_end') {
        finetunerState.phase = 'training'
        if (finetunerIdx >= 0) stageDetails[finetunerIdx] = { ...stageDetails[finetunerIdx], progress: 88 }
      } else if (ftEv.type === 'saving_model') {
        finetunerState.phase = 'saving'
        if (finetunerIdx >= 0) stageDetails[finetunerIdx] = { ...stageDetails[finetunerIdx], progress: 92 }
      } else if (ftEv.type === 'model_saved') {
        finetunerState.phase = 'saving'
        if (finetunerIdx >= 0) stageDetails[finetunerIdx] = { ...stageDetails[finetunerIdx], progress: 98 }
      }
      continue
    }
    if (ev.event === 'stop_requested' || ev.event === 'stop_acknowledged') continue
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
    return { stages: stageDetails, overallProgress: 100, logs, evalState, finetunerState }
  }
  return { stages: stageDetails, overallProgress, logs, evalState, finetunerState }
}

/* ------------------------------------------------------------------ */
/*  Synthesize stage details from REST status                          */
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
/*  Intermediate state panels                                          */
/* ------------------------------------------------------------------ */

function FinetunerProgress({ state }: { state: FinetunerState }) {
  const phases = [
    { key: 'loading_model', label: 'Loading model' },
    { key: 'loading_data', label: 'Loading data' },
    { key: 'preparing_data', label: 'Preparing data' },
    { key: 'training', label: 'Training' },
    { key: 'saving', label: 'Saving model' },
  ]

  const phaseIdx = phases.findIndex(x => x.key === state.phase)

  return (
    <div className="space-y-3">
      {/* Phase indicators */}
      <div className="flex items-center gap-2 flex-wrap">
        {phases.map((p, i) => {
          const isActive = state.phase === p.key
          const isPast = phaseIdx > i
          return (
            <div key={p.key} className="flex items-center gap-2">
              {i > 0 && <div className={`w-6 h-px ${isPast || isActive ? 'bg-primary' : 'bg-border'}`} />}
              <div className="flex items-center gap-1.5">
                <div className={`h-2 w-2 rounded-full ${
                  isActive ? 'bg-primary animate-pulse' : isPast ? 'bg-primary' : 'bg-muted-foreground/30'
                }`} />
                <span className={`text-xs ${isActive ? 'text-foreground font-medium' : isPast ? 'text-muted-foreground' : 'text-muted-foreground/50'}`}>
                  {p.label}
                </span>
              </div>
            </div>
          )
        })}
      </div>

      {/* Model name */}
      {state.modelName && state.phase === 'loading_model' && (
        <p className="text-xs text-muted-foreground font-mono truncate">{state.modelName}</p>
      )}

      {/* Dataset info */}
      {state.trainSamples != null && (state.phase === 'preparing_data' || state.phase === 'loading_data') && (
        <p className="text-xs text-muted-foreground">
          {state.trainSamples} train samples{state.evalSamples ? `, ${state.evalSamples} eval samples` : ''}
        </p>
      )}

      {/* Training metrics */}
      {state.phase === 'training' && (
        <div className="space-y-2">
          {/* Epoch & step */}
          <div className="flex items-center gap-4">
            {state.epoch != null && state.totalEpochs != null && (
              <span className="text-xs text-muted-foreground">
                Epoch <span className="font-mono font-medium text-foreground">{state.epoch}</span>/{state.totalEpochs}
              </span>
            )}
            {state.step != null && state.totalSteps != null && state.totalSteps > 0 && (
              <span className="text-xs text-muted-foreground">
                Step <span className="font-mono font-medium text-foreground">{state.step}</span>/{state.totalSteps}
              </span>
            )}
          </div>
          {/* Loss and LR */}
          <div className="flex items-center gap-4">
            {state.loss != null && (
              <div className="flex items-center gap-1.5">
                <span className="text-xs text-muted-foreground">Loss:</span>
                <span className="text-xs font-mono font-medium">{state.loss.toFixed(4)}</span>
              </div>
            )}
            {state.learningRate != null && (
              <div className="flex items-center gap-1.5">
                <span className="text-xs text-muted-foreground">LR:</span>
                <span className="text-xs font-mono font-medium">{state.learningRate.toExponential(2)}</span>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

<<<<<<< HEAD
function EvalProgressPanel({ state }: { state: EvalState }) {
  if (!state.phase && state.systems.length === 0) return null
=======
interface MonitorProgressProps {
  runId: string | null
  config: PipelineConfigPayload | null
  wsEvents?: WsEvent[]
  isConnected?: boolean
  onDone: (result: unknown) => void
  /** When set, only show monitoring for this specific stage */
  stageFilter?: string
}
>>>>>>> 3194a5a3cd2e312762d7a1e18bc34481382095f4

  const SYSTEM_LABELS: Record<string, string> = {
    distilled: 'Finetuned',
    base: 'Base Model',
    local_base: 'Base Model',
    graph_rag: 'Graph RAG',
  }

  return (
    <div className="space-y-3">
      {/* Phase indicators */}
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-2">
          <div className={`h-2 w-2 rounded-full ${state.phase === 'predicting' ? 'bg-primary animate-pulse' : state.phase === 'scoring' ? 'bg-primary' : 'bg-muted-foreground/30'}`} />
          <span className={`text-xs ${state.phase === 'predicting' ? 'text-foreground font-medium' : 'text-muted-foreground'}`}>
            Generating predictions
          </span>
        </div>
        <div className="w-6 h-px bg-border" />
        <div className="flex items-center gap-2">
          <div className={`h-2 w-2 rounded-full ${state.phase === 'scoring' ? 'bg-primary animate-pulse' : 'bg-muted-foreground/30'}`} />
          <span className={`text-xs ${state.phase === 'scoring' ? 'text-foreground font-medium' : 'text-muted-foreground'}`}>
            Scoring with judge
          </span>
        </div>
      </div>

      {/* Per-system prediction progress */}
      {state.systems.length > 0 && state.phase === 'predicting' && (
        <div className="space-y-1.5">
          {state.systems.map(sys => {
            const label = sys.label || SYSTEM_LABELS[sys.kind] || sys.id
            const isActive = sys.status === 'running'
            const isDone = sys.status === 'done'
            const pct = sys.total > 0 ? Math.round((sys.completed / sys.total) * 100) : 0
            return (
              <div key={sys.id} className="flex items-center gap-2">
                <div className={`h-1.5 w-1.5 rounded-full shrink-0 ${
                  isActive ? 'bg-primary animate-pulse' : isDone ? 'bg-green-500' : 'bg-muted-foreground/30'
                }`} />
                <span className={`text-xs w-24 truncate ${isActive ? 'text-foreground font-medium' : 'text-muted-foreground'}`}>
                  {label}
                </span>
                <Progress value={pct} className="flex-1 h-1.5" />
                <span className="text-xs font-mono text-muted-foreground w-16 text-right">
                  {sys.completed}/{sys.total || '?'}
                </span>
              </div>
            )
          })}
        </div>
      )}

      {/* Scoring progress */}
      {state.phase === 'scoring' && (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">GEval scoring:</span>
            <Progress value={state.scoringTotal ? Math.round(((state.scoringIndex ?? 0) / state.scoringTotal) * 100) : 0} className="flex-1 h-1.5" />
            <span className="text-xs font-mono text-muted-foreground">
              {state.scoringIndex ?? 0}/{state.scoringTotal ?? '?'}
            </span>
          </div>
          {state.scorers && (
            <div className="flex flex-wrap gap-1">
              {state.scorers.map(s => (
                <Badge key={s} variant="outline" className="text-[10px] font-mono">{s}</Badge>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Last scores — nested {system: {metric: score}} */}
      {state.lastScores && Object.keys(state.lastScores).length > 0 && (
        <div className="space-y-2">
          <span className="text-[10px] text-muted-foreground">Latest sample scores:</span>
          {Object.entries(state.lastScores).map(([sysId, metrics]) => {
            if (!metrics || typeof metrics !== 'object') return null
            const LABELS: Record<string, string> = { distilled: 'Finetuned', base: 'Base', local_base: 'Base', graph_rag: 'Graph RAG' }
            return (
              <div key={sysId}>
                <span className="text-[10px] font-medium text-muted-foreground">{LABELS[sysId] ?? sysId}</span>
                <div className="grid grid-cols-3 sm:grid-cols-4 gap-1 mt-0.5">
                  {Object.entries(metrics).filter(([k]) => !k.endsWith('_failed')).map(([k, v]) => (
                    <div key={k} className="flex items-center justify-between rounded border px-1.5 py-0.5">
                      <span className="text-[9px] text-muted-foreground truncate mr-1">{k}</span>
                      <span className="text-[10px] font-mono font-medium">{typeof v === 'number' ? v.toFixed(2) : v == null ? '—' : String(v)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Main component                                                     */
/* ------------------------------------------------------------------ */

<<<<<<< HEAD
export default function MonitorProgress({ runId, config, wsEvents = [], isConnected, onDone, onStop }: MonitorProgressProps) {
=======
export default function MonitorProgress({ runId, config, wsEvents = [], isConnected, onDone, stageFilter }: MonitorProgressProps) {
>>>>>>> 3194a5a3cd2e312762d7a1e18bc34481382095f4
  const [polledEvents, setPolledEvents] = useState<WsEvent[]>([])
  const [polledStages, setPolledStages] = useState<string[]>([])
  const [runStatus, setRunStatus] = useState<string | null>(null)
  const [statusDerivedStages, setStatusDerivedStages] = useState<StageDetail[]>([])
  const [statusDerivedLogs, setStatusDerivedLogs] = useState<string[]>([])
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const eventCursorRef = useRef(0)
  const lastStatusLogRef = useRef<string | null>(null)

  const runOrder = config?.run_stages ?? polledStages
  const hasLiveEvents = wsEvents.length > 0
  const effectiveEvents = hasLiveEvents ? wsEvents : polledEvents

  const eventDerived = useMemo(() => {
    if (effectiveEvents.length === 0 && runOrder.length === 0) return null
    if (effectiveEvents.length === 0) return null
    return stagesFromWsEvents(effectiveEvents, runOrder)
  }, [effectiveEvents, runOrder])

  // Poll fallback
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

        if (status.stages && status.stages.length > 0) {
          setStatusDerivedStages(stagesFromRunStatus(status))
          const currentLabel = status.current_stage
            ? (STAGE_LABELS[status.current_stage as keyof typeof STAGE_LABELS] ?? status.current_stage)
            : null
          const cc = (status.results ?? []).filter((r) => r.success).length
          const totalCount = status.stages.length
          const ts = new Date().toISOString().slice(11, 19)
          let logMsg: string
          if (status.status === 'running' && currentLabel) {
            logMsg = `[${ts}] [INFO] Running stage: ${currentLabel} (${cc}/${totalCount} completed)`
          } else if (status.status === 'completed') {
            logMsg = `[${ts}] [INFO] Pipeline completed (${cc}/${totalCount} stages)`
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

        try {
          const evtRes = await getRunEvents(runId, eventCursorRef.current)
          if (cancelled) return
          if (evtRes.events.length > 0) {
            setPolledEvents((prev) => [...prev, ...evtRes.events])
            eventCursorRef.current = evtRes.total
          }
        } catch {
          // /events endpoint not available
        }

        if (status.status === 'completed' || status.status === 'failed' || status.status === 'cancelled') {
          if (pollRef.current) {
            clearInterval(pollRef.current)
            pollRef.current = null
          }
          onDone(status)
        }
      } catch {
        // Ignore fetch errors
      }
    }

    setPolledEvents([])
    setPolledStages([])
    setStatusDerivedStages([])
    setStatusDerivedLogs([])
    setRunStatus(null)
    eventCursorRef.current = 0
    lastStatusLogRef.current = null

    fetchData()
    pollRef.current = setInterval(() => { if (!cancelled) fetchData() }, 2000)

    return () => {
      cancelled = true
      if (pollRef.current) {
        clearInterval(pollRef.current)
        pollRef.current = null
      }
    }
  }, [runId, hasLiveEvents, onDone])

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
  const evalState = eventDerived?.evalState ?? { systems: [] }
  const finetunerState = eventDerived?.finetunerState ?? {}

  // Track which accordion items are open — auto-open running stages and keep graph visible
  const [openItems, setOpenItems] = useState<string[]>([])
  const prevRunningRef = useRef<Set<string>>(new Set())

  useEffect(() => {
    const running = new Set(
      displayStages
        .filter(s => s.status === 'running')
        .map(s => s.id ?? s.name),
    )
    // Graph traverser stays open when completed
    const graphStage = displayStages.find(s => s.id === 'graph_traverser')
    if (graphStage && (graphStage.status === 'completed' || graphStage.status === 'running')) {
      running.add('graph_traverser')
    }
    // Only add newly running items — don't remove user-opened items
    const newlyRunning = [...running].filter(id => !prevRunningRef.current.has(id))
    if (newlyRunning.length > 0) {
      setOpenItems(prev => [...new Set([...prev, ...newlyRunning])])
    }
    prevRunningRef.current = running
  }, [displayStages])

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
    <div className="space-y-4">
      {/* -- Overall Progress -- */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle>Pipeline Progress</CardTitle>
            <div className="flex items-center gap-2">
              {isConnected !== undefined && (
                <div className={`flex items-center gap-1.5 text-xs px-2 py-1 rounded-full ${isConnected ? 'bg-green-500/10 text-green-600 dark:bg-green-500/10 dark:text-green-400' : 'bg-red-500/10 text-red-600 dark:bg-red-500/10 dark:text-red-400'}`}>
                  {isConnected ? <Wifi className="h-3 w-3" /> : <WifiOff className="h-3 w-3" />}
                  {isConnected ? 'Live' : 'Disconnected'}
                </div>
              )}
              {onStop && (isConnected || runStatus === 'running') && (
                <Button variant="outline" size="sm" onClick={onStop} className="gap-1.5 text-xs h-6 px-2 text-muted-foreground hover:text-destructive hover:border-destructive/30">
                  <StopCircle className="h-3 w-3" />
                  Stop
                </Button>
              )}
              {!isConnected && runStatus && (
                <Badge variant={runStatus === 'completed' ? 'success' : runStatus === 'failed' || runStatus === 'cancelled' ? 'destructive' : 'secondary'} className="text-xs">
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

      {/* -- Stage Accordions -- */}
      {displayStages.length === 0 ? (
        <Card>
          <CardContent className="py-8">
            <div className="flex flex-col items-center justify-center text-muted-foreground">
              <FileText className="h-8 w-8 mb-2" />
              <p className="text-sm">No stages configured. Start a pipeline run to see stage details.</p>
            </div>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <Accordion type="multiple" value={openItems} onValueChange={setOpenItems}>
            {displayStages.map((stage) => {
              const isRunning = stage.status === 'running'
              const isCompleted = stage.status === 'completed'
              const isFailed = stage.status === 'failed'
              const stageKey = stage.id ?? stage.name

              return (
                <AccordionItem key={stageKey} value={stageKey} className="border-b last:border-b-0 px-2">
                  <AccordionTrigger className="hover:no-underline py-3">
                    <div className="flex items-center gap-3 flex-1 min-w-0">
                      <StageStatusIcon status={stage.status} />
                      <span className="text-muted-foreground">
                        {STAGE_ICONS[stage.id ?? ''] ?? <FileText className="h-4 w-4" />}
                      </span>
                      <span className="font-medium text-sm">{stage.name}</span>
                      <Badge
                        variant={
                          isCompleted ? 'success'
                          : isFailed ? 'destructive'
                          : isRunning ? 'default'
                          : 'outline'
                        }
                        className={`text-xs ${isRunning ? 'animate-pulse' : ''}`}
                      >
                        {stage.status}
                      </Badge>
                      {stage.status !== 'pending' && (
                        <span className="text-xs text-muted-foreground ml-auto mr-2">{stage.progress}%</span>
                      )}
                    </div>
                  </AccordionTrigger>
                  <AccordionContent>
                    {/* Progress bar */}
                    {stage.status !== 'pending' && (
                      <div className="flex items-center gap-2 mb-3">
                        <Progress value={stage.progress} className="flex-1 h-1.5" />
                      </div>
                    )}

                    {/* Error */}
                    {stage.error && (
                      <p className="text-sm text-destructive mb-3">{stage.error}</p>
                    )}

                    {/* Finetuner intermediate state */}
                    {stage.id === 'finetuner' && isRunning && finetunerState.phase && (
                      <FinetunerProgress state={finetunerState} />
                    )}

                    {/* Evaluator intermediate state */}
                    {stage.id === 'evaluator' && isRunning && (
                      <EvalProgressPanel state={evalState} />
                    )}

                    {/* Graph traverser: visualization + activity (shown while running AND after completion) */}
                    {stage.id === 'graph_traverser' && (isRunning || isCompleted) && (
                      <div className="space-y-4 mt-2">
                        <GraphVisualization wsEvents={effectiveEvents} />
                        <TraversalActivity wsEvents={effectiveEvents} />
                      </div>
                    )}
                  </AccordionContent>
                </AccordionItem>
              )
            })}
          </Accordion>
        </Card>
      )}

      {/* -- Execution Logs Accordion -- */}
      <Card>
        <Accordion type="multiple">
          <AccordionItem value="logs" className="border-b-0 px-2">
            <AccordionTrigger className="hover:no-underline py-3">
              <div className="flex items-center gap-2">
                <FileText className="h-4 w-4 text-muted-foreground" />
                <span className="font-medium text-sm">Execution Logs</span>
                {displayLogs.length > 0 && (
                  <Badge variant="outline" className="text-xs">{displayLogs.length}</Badge>
                )}
              </div>
            </AccordionTrigger>
            <AccordionContent>
              {displayLogs.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-6 text-muted-foreground">
                  <AlertTriangle className="h-8 w-8" />
                  <p className="text-sm mt-2">
                    {runId ? 'Waiting for logs...' : 'No logs yet.'}
                  </p>
                </div>
              ) : (
                <pre className="text-xs font-mono rounded-md border bg-muted/50 p-3 max-h-64 overflow-y-auto whitespace-pre-wrap">
                  {displayLogs.join('\n')}
                </pre>
              )}
            </AccordionContent>
          </AccordionItem>
        </Accordion>
      </Card>
    </div>
  )
}
