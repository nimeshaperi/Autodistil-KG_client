import { useState } from 'react'
import { FolderInput, RefreshCw, Download, ChevronDown } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import { downloadRunArtifact, type RunResultResponse } from '@/api/client'

interface ResultsOutputProps {
  runId: string | null
  result: unknown
  onRefresh: () => void
  stageFilter?: string
}

interface EvalReport {
  evalg_mode?: string
  num_samples?: number
  metrics_used?: string[]
  timestamp?: string
  systems?: Record<string, {
    label?: string
    kind?: string
    aggregate_metrics?: Record<string, number>
  }>
  per_question?: Array<{
    index: number
    question: string
    reference: string
    predictions: Record<string, string>
    scores: Record<string, Record<string, number>>
  }>
}

function MetricsComparisonTable({ report }: { report: EvalReport }) {
  const systems = report.systems ?? {}
  const systemIds = Object.keys(systems)
  if (systemIds.length === 0) return null

  const allMetricNames = new Set<string>()
  for (const sys of Object.values(systems)) {
    for (const key of Object.keys(sys.aggregate_metrics ?? {})) {
      allMetricNames.add(key)
    }
  }
  const metricNames = Array.from(allMetricNames).sort()

  const findBest = (metric: string): string | null => {
    let best: string | null = null
    let bestVal = -Infinity
    for (const sysId of systemIds) {
      const val = systems[sysId]?.aggregate_metrics?.[metric]
      if (val != null && val > bestVal) {
        bestVal = val
        best = sysId
      }
    }
    return best
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm border-collapse">
        <thead>
          <tr className="border-b">
            <th className="text-left p-2 font-medium text-muted-foreground">Metric</th>
            {systemIds.map((id) => (
              <th key={id} className="text-right p-2 font-medium">
                <div>{systems[id]?.label ?? id}</div>
                <div className="text-xs font-normal text-muted-foreground">{systems[id]?.kind}</div>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {metricNames.map((metric) => {
            const bestId = findBest(metric)
            return (
              <tr key={metric} className="border-b last:border-0">
                <td className="p-2 font-mono text-xs">{metric}</td>
                {systemIds.map((sysId) => {
                  const val = systems[sysId]?.aggregate_metrics?.[metric]
                  const isBest = sysId === bestId
                  return (
                    <td
                      key={sysId}
                      className={`text-right p-2 font-mono text-xs ${isBest ? 'font-bold text-green-600 dark:text-green-400' : ''}`}
                    >
                      {val != null ? val.toFixed(4) : '—'}
                    </td>
                  )
                })}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function PerQuestionDetails({ report }: { report: EvalReport }) {
  const questions = report.per_question ?? []
  const systemIds = Object.keys(report.systems ?? {})
  if (questions.length === 0) return null

  return (
    <div className="space-y-2">
      {questions.map((q, idx) => (
        <Collapsible key={idx}>
          <CollapsibleTrigger className="flex w-full items-center gap-2 py-2 px-3 text-left text-sm font-medium rounded-md border hover:bg-muted/50 [&[data-state=open]>svg]:rotate-180">
            <span className="text-xs text-muted-foreground font-mono w-8">#{q.index + 1}</span>
            <span className="flex-1 truncate">{q.question}</span>
            <ChevronDown className="h-4 w-4 ml-auto transition-transform shrink-0" />
          </CollapsibleTrigger>
          <CollapsibleContent className="px-3 pb-3">
            <div className="space-y-3 mt-2">
              <div>
                <span className="text-xs font-medium text-muted-foreground">Reference:</span>
                <p className="text-xs mt-1 p-2 rounded bg-muted/50 border whitespace-pre-wrap">{q.reference}</p>
              </div>
              {systemIds.map((sysId) => (
                <div key={sysId}>
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-medium">{report.systems?.[sysId]?.label ?? sysId}</span>
                    {q.scores?.[sysId] && (
                      <span className="text-xs text-muted-foreground">
                        [{Object.entries(q.scores[sysId]).map(([k, v]) => `${k}: ${v.toFixed(2)}`).join(', ')}]
                      </span>
                    )}
                  </div>
                  <p className="text-xs mt-1 p-2 rounded bg-muted/30 border whitespace-pre-wrap">
                    {q.predictions?.[sysId] ?? '(no prediction)'}
                  </p>
                </div>
              ))}
            </div>
          </CollapsibleContent>
        </Collapsible>
      ))}
    </div>
  )
}

export default function ResultsOutput({ runId, result, onRefresh, stageFilter }: ResultsOutputProps) {
  const [downloadError, setDownloadError] = useState<string | null>(null)
  const runResult = result as RunResultResponse | null
  const hasResult = runResult != null
  const success = runResult?.success ?? false
  const results = runResult?.results ?? []
  const context = runResult?.context ?? {}
  const error = runResult?.error
  const chatmlPath = (!stageFilter || stageFilter === 'chatml_converter' || stageFilter === 'graph_traverser')
    ? context?.chatml_dataset_path as string | undefined : undefined
  const preparedPath = (!stageFilter || stageFilter === 'chatml_converter' || stageFilter === 'finetuner')
    ? context?.prepared_dataset_path as string | undefined : undefined
  const evalReportPath = (!stageFilter || stageFilter === 'evaluator')
    ? context?.eval_report_path as string | undefined : undefined

  // Extract the full eval report from the last result metadata
  const lastResult = results.length > 0 ? results[results.length - 1] : null
  const rawReport = (lastResult?.metadata as { raw_report?: EvalReport } | undefined)?.raw_report
  const evalMetrics = (lastResult?.metadata as { metrics?: Record<string, unknown> } | undefined)?.metrics

  const handleDownload = async (artifactKey: 'chatml' | 'prepared' | 'eval_report') => {
    if (!runId) return
    setDownloadError(null)
    try {
      await downloadRunArtifact(runId, artifactKey)
    } catch (e) {
      setDownloadError(e instanceof Error ? e.message : 'Download failed')
    }
  }

  return (
    <div className="space-y-6">
      <Card className="min-h-[320px] flex flex-col items-center justify-center">
        <CardContent className="p-8 flex flex-col items-center justify-center w-full">
          {!hasResult ? (
            <>
              <FolderInput className="h-14 w-14 text-muted-foreground" aria-hidden />
              <h2 className="text-lg font-semibold mt-4">No Results Yet</h2>
              <p className="text-sm text-muted-foreground mt-1 text-center max-w-sm">
                Run the pipeline to generate outputs and view results here
              </p>
              <Button variant="outline" className="mt-6" onClick={onRefresh}>
                <RefreshCw className="h-4 w-4" />
                Refresh Page
              </Button>
            </>
          ) : (
            <>
              <div className="w-full text-left">
                <div className="flex items-center gap-2 mb-4">
                  <Badge variant={success ? 'default' : 'destructive'}>
                    {success ? 'Completed' : 'Failed'}
                  </Badge>
                  {runId && (
                    <span className="text-xs text-muted-foreground font-mono">Run ID: {runId}</span>
                  )}
                </div>
                {error && (
                  <p className="text-sm text-destructive mb-4" role="alert">
                    {error}
                  </p>
                )}
                {results.length > 0 && (
                  <div className="mb-4">
                    <h3 className="text-sm font-medium mb-2">Stage results</h3>
                    <ul className="list-disc list-inside text-sm text-muted-foreground space-y-1">
                      {results.map((r, i) => (
                        <li key={i}>
                          Stage {i + 1}: {r.success ? 'Success' : 'Failed'}
                          {r.error && ` — ${r.error}`}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {Object.keys(context).length > 0 && (
                  <details className="mt-2">
                    <summary className="text-sm font-medium cursor-pointer">
                      Downloads &amp; output paths
                    </summary>
                    <div className="mt-2 space-y-3">
                      {chatmlPath && runId && (
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-xs text-muted-foreground font-mono break-all flex-1 min-w-0">{chatmlPath}</span>
                          <Button type="button" variant="outline" size="sm" onClick={() => handleDownload('chatml')} className="shrink-0">
                            <Download className="h-3.5 w-3.5" />
                            Download JSONL
                          </Button>
                        </div>
                      )}
                      {preparedPath && runId && (
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-xs text-muted-foreground font-mono break-all flex-1 min-w-0">{preparedPath}</span>
                          <Button type="button" variant="outline" size="sm" onClick={() => handleDownload('prepared')} className="shrink-0">
                            <Download className="h-3.5 w-3.5" />
                            Download prepared
                          </Button>
                        </div>
                      )}
                      {evalReportPath && runId && (
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-xs text-muted-foreground font-mono break-all flex-1 min-w-0">{evalReportPath}</span>
                          <Button type="button" variant="outline" size="sm" onClick={() => handleDownload('eval_report')} className="shrink-0">
                            <Download className="h-3.5 w-3.5" />
                            Download eval report
                          </Button>
                        </div>
                      )}
                      <pre className="p-3 rounded-md border bg-muted/50 text-xs overflow-x-auto">
                        {JSON.stringify(context, null, 2)}
                      </pre>
                    </div>
                  </details>
                )}
                {downloadError && (
                  <p className="text-sm text-destructive mt-2" role="alert">
                    {downloadError}
                  </p>
                )}
              </div>
              <Button variant="outline" className="mt-6" onClick={onRefresh}>
                <RefreshCw className="h-4 w-4" />
                Refresh Page
              </Button>
            </>
          )}
        </CardContent>
      </Card>

      {(!stageFilter || stageFilter === 'evaluator') && rawReport && rawReport.systems && Object.keys(rawReport.systems).length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Evaluation Comparison</CardTitle>
            <div className="flex items-center gap-3 text-xs text-muted-foreground">
              <span>Mode: {rawReport.evalg_mode ?? 'unknown'}</span>
              <span>{rawReport.num_samples ?? 0} samples</span>
              {rawReport.metrics_used && <span>Metrics: {rawReport.metrics_used.join(', ')}</span>}
            </div>
          </CardHeader>
          <CardContent>
            <MetricsComparisonTable report={rawReport} />
          </CardContent>
        </Card>
      )}

      {(!stageFilter || stageFilter === 'evaluator') && rawReport && (rawReport.per_question ?? []).length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Per-Question Breakdown</CardTitle>
            <p className="text-xs text-muted-foreground">
              Click a question to see predictions and scores from each system.
            </p>
          </CardHeader>
          <CardContent>
            <PerQuestionDetails report={rawReport} />
          </CardContent>
        </Card>
      )}

      {(!stageFilter || stageFilter === 'evaluator') && !rawReport && evalMetrics && (
        <Card>
          <CardHeader>
            <CardTitle>Evaluation Metrics</CardTitle>
          </CardHeader>
          <CardContent>
            <pre className="p-3 rounded-md border bg-muted/50 text-xs overflow-x-auto">
              {JSON.stringify(evalMetrics, null, 2)}
            </pre>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
