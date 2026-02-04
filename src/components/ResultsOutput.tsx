import { useState } from 'react'
import { FolderInput, RefreshCw, Download } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { downloadRunArtifact, type RunResultResponse } from '@/api/client'

interface ResultsOutputProps {
  runId: string | null
  result: unknown
  onRefresh: () => void
}

export default function ResultsOutput({ runId, result, onRefresh }: ResultsOutputProps) {
  const [downloadError, setDownloadError] = useState<string | null>(null)
  const runResult = result as RunResultResponse | null
  const hasResult = runResult != null
  const success = runResult?.success ?? false
  const results = runResult?.results ?? []
  const context = runResult?.context ?? {}
  const error = runResult?.error
  const chatmlPath = context?.chatml_dataset_path as string | undefined
  const preparedPath = context?.prepared_dataset_path as string | undefined

  const handleDownload = async (artifactKey: 'chatml' | 'prepared') => {
    if (!runId) return
    setDownloadError(null)
    try {
      await downloadRunArtifact(runId, artifactKey)
    } catch (e) {
      setDownloadError(e instanceof Error ? e.message : 'Download failed')
    }
  }

  return (
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
                <details className="mt-2" open>
                  <summary className="text-sm font-medium cursor-pointer">
                    Context / output paths
                  </summary>
                  <div className="mt-2 space-y-3">
                    {chatmlPath && runId && (
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-xs text-muted-foreground font-mono break-all flex-1 min-w-0">{chatmlPath}</span>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => handleDownload('chatml')}
                          className="shrink-0"
                        >
                          <Download className="h-3.5 w-3.5" />
                          Download JSONL
                        </Button>
                      </div>
                    )}
                    {preparedPath && runId && (
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-xs text-muted-foreground font-mono break-all flex-1 min-w-0">{preparedPath}</span>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => handleDownload('prepared')}
                          className="shrink-0"
                        >
                          <Download className="h-3.5 w-3.5" />
                          Download prepared
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
  )
}
