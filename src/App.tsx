import React, { useState, useCallback } from 'react'
import { Tabs } from '@/components/ui/tabs'
import Header from './components/Header'
import ConfigurePipeline from './components/ConfigurePipeline'
import MonitorProgress from './components/MonitorProgress'
import ResultsOutput from './components/ResultsOutput'
import RunHistory from './components/RunHistory'
import type { PipelineConfigPayload } from './types/config'
import type { WsEvent } from './api/client'

export type TabId = 'configure' | 'monitor' | 'results'

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
  const [activeTab, setActiveTab] = useState<TabId>('configure')
  const [sessions, setSessions] = useState<Map<string, RunSession>>(new Map())
  const [activeRunId, setActiveRunId] = useState<string | null>(null)

  const activeSession = activeRunId ? sessions.get(activeRunId) : undefined

  const handleRun = useCallback((runId: string, cfg: PipelineConfigPayload) => {
    setSessions((prev) => {
      const next = new Map(prev)
      next.set(runId, emptySession(runId, cfg))
      return next
    })
    setActiveRunId(runId)
    setActiveTab('monitor')
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
    setActiveTab('results')
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
    setActiveTab('monitor')
  }, [sessions])

  return (
    <Tabs
      value={activeTab}
      onValueChange={(v) => setActiveTab(v as TabId)}
      className="min-h-screen bg-[#f5f8fa]"
    >
      <Header />
      <main className="max-w-5xl mx-auto px-4 py-6">
        <RunHistory currentRunId={activeRunId} onSelectRun={handleSelectRun} />
        {activeTab === 'configure' && (
          <ConfigurePipeline
            onRun={handleRun}
            onExportConfig={() => {}}
            setWsEvents={setWsEvents}
            setIsConnected={setIsConnected}
            onDone={handleDone}
          />
        )}
        {activeTab === 'monitor' && (
          <MonitorProgress
            runId={activeRunId}
            config={activeSession?.config ?? null}
            wsEvents={activeSession?.wsEvents ?? []}
            isConnected={activeSession?.isWsConnected}
            onDone={handleDone}
          />
        )}
        {activeTab === 'results' && (
          <ResultsOutput
            runId={activeRunId}
            result={activeSession?.result ?? null}
            onRefresh={() => setActiveTab('monitor')}
          />
        )}
      </main>
    </Tabs>
  )
}
