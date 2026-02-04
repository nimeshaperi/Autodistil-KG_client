import { useState, useCallback } from 'react'
import { Tabs } from '@/components/ui/tabs'
import Header from './components/Header'
import ConfigurePipeline from './components/ConfigurePipeline'
import MonitorProgress from './components/MonitorProgress'
import ResultsOutput from './components/ResultsOutput'
import type { PipelineConfigPayload } from './types/config'
import type { WsEvent } from './api/client'

export type TabId = 'configure' | 'monitor' | 'results'

export default function App() {
  const [activeTab, setActiveTab] = useState<TabId>('configure')
  const [lastRunId, setLastRunId] = useState<string | null>(null)
  const [lastResult, setLastResult] = useState<unknown>(null)
  const [config, setConfig] = useState<PipelineConfigPayload | null>(null)
  const [wsEvents, setWsEvents] = useState<WsEvent[]>([])
  const [isWsConnected, setIsWsConnected] = useState<boolean | undefined>(undefined)

  const handleRun = useCallback((runId: string, cfg: PipelineConfigPayload) => {
    setLastRunId(runId)
    setConfig(cfg)
    setWsEvents([])
    setActiveTab('monitor')
  }, [])

  const handleDone = useCallback((result: unknown) => {
    setLastResult(result)
    setActiveTab('results')
  }, [])

  return (
    <Tabs
      value={activeTab}
      onValueChange={(v) => setActiveTab(v as TabId)}
      className="min-h-screen bg-[#f5f8fa]"
    >
      <Header />
      <main className="max-w-5xl mx-auto px-4 py-6">
        {activeTab === 'configure' && (
          <ConfigurePipeline
            onRun={handleRun}
            onExportConfig={(cfg) => setConfig(cfg)}
            setWsEvents={setWsEvents}
            setIsConnected={setIsWsConnected}
            onDone={handleDone}
          />
        )}
        {activeTab === 'monitor' && (
          <MonitorProgress
            runId={lastRunId}
            config={config}
            wsEvents={wsEvents}
            isConnected={isWsConnected}
            onDone={handleDone}
          />
        )}
        {activeTab === 'results' && (
          <ResultsOutput runId={lastRunId} result={lastResult} onRefresh={() => setActiveTab('monitor')} />
        )}
      </main>
    </Tabs>
  )
}
