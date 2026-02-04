/**
 * API base URL: use VITE_API_URL when set (e.g. different host).
 * When unset, use /api so Vite dev proxy (vite.config.ts) forwards to the backend.
 */
const getBaseUrl = (): string => {
  const env = import.meta.env?.VITE_API_URL
  if (env && typeof env === 'string' && env.trim() !== '') {
    return env.replace(/\/$/, '')
  }
  return '/api'
}

export const apiBase = getBaseUrl()

export async function runPipeline(config: Record<string, unknown>, asyncRun = true): Promise<RunResponse> {
  const url = `${apiBase}/pipelines/run${asyncRun ? '?async=true' : ''}`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }))
    throw new Error((err as { detail?: string }).detail || res.statusText)
  }
  return res.json()
}

export async function getRunStatus(runId: string): Promise<RunResultResponse> {
  const res = await fetch(`${apiBase}/pipelines/runs/${runId}`)
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    const detail = (body as { detail?: string }).detail
    throw new Error(detail ? `${res.status}: ${detail}` : res.statusText)
  }
  return res.json()
}

/** URL for downloading a run artifact (chatml or prepared JSONL). */
export function getRunArtifactUrl(runId: string, artifactKey: 'chatml' | 'prepared'): string {
  return `${apiBase}/pipelines/runs/${runId}/artifacts/${artifactKey}`
}

/** Fetch run artifact and trigger browser download. */
export async function downloadRunArtifact(runId: string, artifactKey: 'chatml' | 'prepared'): Promise<void> {
  const url = getRunArtifactUrl(runId, artifactKey)
  const res = await fetch(url)
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    const detail = (body as { detail?: string }).detail
    throw new Error(detail || res.statusText)
  }
  const blob = await res.blob()
  const disposition = res.headers.get('Content-Disposition')
  const match = disposition?.match(/filename="?([^";]+)"?/)
  const filename = match ? match[1].trim() : (artifactKey === 'chatml' ? 'dataset.jsonl' : 'prepared.jsonl')
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = filename
  a.click()
  URL.revokeObjectURL(a.href)
}

export async function healthCheck(): Promise<{ status: string }> {
  const res = await fetch(`${apiBase}/health`)
  if (!res.ok) throw new Error(res.statusText)
  return res.json()
}

export function getWebSocketUrl(): string {
  const base = apiBase || (typeof location !== 'undefined' ? `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}` : 'ws://localhost:8000')
  const wsPath = base.replace(/^http/, 'ws')
  return `${wsPath}/ws`
}

export interface RunResponse {
  run_id: string
  status: string
  message?: string
}

export interface RunResultResponse {
  run_id: string
  status: string
  success: boolean
  context?: Record<string, unknown>
  results?: Array<{ success: boolean; error?: string; metadata?: Record<string, unknown> }>
  error?: string
  stages?: string[]
  current_stage?: string
}

export type WsEvent =
  | { event: 'run_start'; run_id: string }
  | { event: 'pipeline_start'; stages: string[] }
  | { event: 'stage_start'; stage: string }
  | { event: 'stage_end'; stage: string; success: boolean; error?: string; metadata?: Record<string, unknown> }
  | { event: 'done'; success: boolean; context?: Record<string, unknown>; results?: unknown[] }
  | { event: 'error'; message: string }

export interface WsRunCallbacks {
  onRunId: (runId: string) => void
  onEvent: (event: WsEvent) => void
  onDone: (result: RunResultResponse) => void
  onError: (message: string) => void
}

/**
 * Run pipeline via WebSocket for live progress. Calls onRunId with run_id from run_start,
 * onEvent for each event, onDone with final result, onError on connection/error event.
 * Returns a close function to abort the connection.
 */
export function runPipelineViaWebSocket(
  config: Record<string, unknown>,
  callbacks: WsRunCallbacks
): () => void {
  const wsUrl = getWebSocketUrl()
  const ws = new WebSocket(wsUrl)
  let closed = false
  let runId = ''

  const close = () => {
    if (closed) return
    closed = true
    try {
      ws.close()
    } catch {
      // ignore
    }
  }

  ws.onopen = () => {
    ws.send(JSON.stringify({ action: 'run', config }))
  }

  ws.onmessage = (ev) => {
    if (closed) return
    try {
      const payload = JSON.parse(ev.data as string) as WsEvent & { event: string }
      callbacks.onEvent(payload as WsEvent)
      switch (payload.event) {
        case 'run_start':
          runId = (payload as { event: 'run_start'; run_id: string }).run_id
          callbacks.onRunId(runId)
          break
        case 'done': {
          const d = payload as { event: 'done'; success: boolean; context?: Record<string, unknown>; results?: unknown[] }
          callbacks.onDone({
            run_id: runId,
            status: d.success ? 'completed' : 'failed',
            success: d.success,
            context: d.context,
            results: d.results as RunResultResponse['results'],
          })
          close()
          break
        }
        case 'error':
          callbacks.onError((payload as { event: 'error'; message: string }).message)
          close()
          break
        default:
          break
      }
    } catch (e) {
      callbacks.onError(e instanceof Error ? e.message : 'Invalid message')
      close()
    }
  }

  ws.onerror = () => {
    if (!closed) {
      callbacks.onError('WebSocket error')
      close()
    }
  }

  ws.onclose = () => {
    if (!closed) close()
  }

  return close
}
