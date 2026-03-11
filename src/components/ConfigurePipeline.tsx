import { useState, useCallback, useRef } from 'react'
import { Download, Upload, Play, Database, FileText, Globe, Check, ChevronDown, Cpu, BarChart3 } from 'lucide-react'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Switch } from '@/components/ui/switch'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import type { PipelineConfigPayload, StageId, GraphTraverserConfig, ChatMLConverterConfig, FineTunerConfig, EvaluatorConfig, RedisConfig, LLMConfig } from '@/types/config'
import { STAGE_ORDER, STAGE_LABELS } from '@/types/config'
import { runPipeline, runPipelineViaWebSocket } from '@/api/client'
import type { RunResultResponse } from '@/api/client'
import type { WsEvent } from '@/api/client'
import { cn } from '@/lib/utils'

const STAGE_DESCRIPTIONS: Record<StageId, string> = {
  graph_traverser: 'Traverse Neo4j graph and generate conversations',
  chatml_converter: 'Convert and prepare ChatML datasets',
  finetuner: 'Fine-tune models with Unsloth',
  evaluator: 'Compare finetuned vs base models with ROUGE & LLM judge',
}

const STRATEGY_OPTIONS = [
  { value: 'bfs', label: 'Breadth-First Search', description: 'Explore graph layer by layer from seed nodes.' },
  { value: 'dfs', label: 'Depth-First Search', description: 'Explore graph depth-first along each branch.' },
  { value: 'random', label: 'Random Walk', description: 'Randomly select neighbours at each step.' },
  { value: 'semantic', label: 'Semantic (LLM-guided)', description: 'LLM selects the most relevant neighbour based on context.' },
  { value: 'reasoning', label: 'Reasoning (multi-hop)', description: 'Deep multi-hop reasoning with subgraph exploration.' },
]

const defaultTraversal = {
  strategy: 'bfs',
  max_nodes: 500,
  max_depth: 5,
  reasoning_depth: 2,
  max_paths_per_node: 15,
}

const defaultDataset = {
  seed_prompts: ['What can you tell me about this node? Describe: {properties}'],
  include_metadata: true,
}

const defaultRedis: RedisConfig = {
  host: 'localhost',
  port: 6379,
  db: 0,
  password: '',
  key_prefix: 'graph_traverser:',
}

const defaultLLM: LLMConfig = {
  provider: 'openai',
  api_key: '',
  model: 'gpt-4',
  base_url: '',
}

const defaultGraphTraverser: GraphTraverserConfig = {
  output_path: 'output/dataset.jsonl',
  traversal: defaultTraversal,
  dataset: defaultDataset,
  neo4j: { uri: 'bolt://localhost:7687', database: '', username: 'neo4j', password: '' },
  redis: defaultRedis,
  llm: defaultLLM,
}

const defaultChatML: ChatMLConverterConfig = {
  input_path: 'output/dataset.jsonl',
  output_path: 'output/prepared.jsonl',
  prepare_for_finetuning: true,
  chat_template: 'auto',
}

// Only Gemma 3 models are allowed for now (Unsloth)
const GEMMA_3_MODELS = [
  { value: 'unsloth/gemma-3-270m-it', label: 'Gemma 3 270M (instruction-tuned)' },
  { value: 'unsloth/gemma-3-1b-it', label: 'Gemma 3 1B (instruction-tuned)' },
  { value: 'unsloth/gemma-3-4b-it', label: 'Gemma 3 4B (instruction-tuned)' },
] as const

const defaultFineTuner: FineTunerConfig = {
  model_name: GEMMA_3_MODELS[0].value,
  model_type: 'gemma3',
  train_data_path: 'output/prepared.jsonl',
  output_dir: 'output/finetuned',
  max_seq_length: 2048,
  num_train_epochs: 1,
  per_device_train_batch_size: 2,
  learning_rate: 2e-4,
}

const LLM_PROVIDERS = [
  { value: 'openai', label: 'OpenAI' },
  { value: 'claude', label: 'Claude' },
  { value: 'gemini', label: 'Gemini' },
  { value: 'ollama', label: 'Ollama' },
  { value: 'vllm', label: 'vLLM' },
] as const

const defaultEvaluator: EvaluatorConfig = {
  eval_dataset_path: 'output/prepared.jsonl',
  output_report_path: 'output/eval_report.json',
  metrics: ['rouge'],
  evalg_mode: 'internal',
  graph_rag_enabled: false,
}

interface ConfigurePipelineProps {
  onRun: (runId: string, config: PipelineConfigPayload) => void
  onExportConfig?: (config: PipelineConfigPayload) => void
  setWsEvents?: React.Dispatch<React.SetStateAction<WsEvent[]>>
  setIsConnected?: React.Dispatch<React.SetStateAction<boolean | undefined>>
  onDone?: (result: RunResultResponse) => void
}

const VALID_STAGES: StageId[] = ['graph_traverser', 'chatml_converter', 'finetuner', 'evaluator']

function parseImportedConfig(data: unknown): PipelineConfigPayload | null {
  if (!data || typeof data !== 'object') return null
  const o = data as Record<string, unknown>
  const run_stages = (Array.isArray(o.run_stages)
    ? (o.run_stages as string[]).filter((id) => VALID_STAGES.includes(id as StageId))
    : []) as StageId[]
  if (run_stages.length === 0) return null
  return {
    output_dir: typeof o.output_dir === 'string' ? o.output_dir : undefined,
    run_stages,
    graph_traverser: o.graph_traverser && typeof o.graph_traverser === 'object'
      ? (o.graph_traverser as GraphTraverserConfig)
      : undefined,
    chatml_converter: o.chatml_converter && typeof o.chatml_converter === 'object'
      ? (o.chatml_converter as ChatMLConverterConfig)
      : undefined,
    finetuner: o.finetuner && typeof o.finetuner === 'object'
      ? (o.finetuner as FineTunerConfig)
      : undefined,
    evaluator: o.evaluator && typeof o.evaluator === 'object'
      ? (o.evaluator as EvaluatorConfig)
      : undefined,
  }
}

export default function ConfigurePipeline({ onRun, onExportConfig, setWsEvents, setIsConnected, onDone }: ConfigurePipelineProps) {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [selectedStages, setSelectedStages] = useState<StageId[]>(['graph_traverser', 'chatml_converter'])
  const [graphTraverser, setGraphTraverser] = useState<GraphTraverserConfig>(defaultGraphTraverser)
  const [chatml, setChatml] = useState<ChatMLConverterConfig>(defaultChatML)
  const [finetuner, setFinetuner] = useState<FineTunerConfig>(defaultFineTuner)
  const [evaluator, setEvaluator] = useState<EvaluatorConfig>(defaultEvaluator)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [importError, setImportError] = useState<string | null>(null)

  const toggleStage = (id: StageId) => {
    setSelectedStages((prev) =>
      prev.includes(id) ? prev.filter((s) => s !== id) : [...prev, id]
    )
  }

  const buildConfig = useCallback((): PipelineConfigPayload => {
    const run_stages = [...selectedStages].sort(
      (a, b) => STAGE_ORDER.indexOf(a) - STAGE_ORDER.indexOf(b)
    )
    const payload: PipelineConfigPayload = {
      output_dir: './output',
      run_stages,
    }
    if (selectedStages.includes('graph_traverser')) {
      const csvToArray = (v?: string) => v ? v.split(',').map((s) => s.trim()).filter(Boolean) : undefined
      const t = graphTraverser.traversal
      payload.graph_traverser = {
        ...graphTraverser,
        output_path: graphTraverser.output_path || 'output/dataset.jsonl',
        traversal: {
          strategy: t.strategy,
          max_nodes: t.max_nodes,
          max_depth: t.max_depth,
          ...(t.strategy === 'reasoning' ? { reasoning_depth: t.reasoning_depth ?? 2, max_paths_per_node: t.max_paths_per_node ?? 15 } : {}),
          relationship_types: csvToArray(t.relationship_types) as unknown as string,
          node_labels: csvToArray(t.node_labels) as unknown as string,
          seed_node_ids: csvToArray(t.seed_node_ids) as unknown as string,
        },
        dataset: {
          ...graphTraverser.dataset,
          seed_prompts: graphTraverser.dataset.seed_prompts.filter(Boolean),
        },
      }
    }
    if (selectedStages.includes('chatml_converter')) {
      payload.chatml_converter = { ...chatml }
    }
    if (selectedStages.includes('finetuner')) {
      const allowedModel = GEMMA_3_MODELS.some((m) => m.value === finetuner.model_name)
        ? finetuner.model_name
        : GEMMA_3_MODELS[0].value
      payload.finetuner = {
        ...finetuner,
        model_name: allowedModel,
        model_type: 'gemma3',
      }
    }
    if (selectedStages.includes('evaluator')) {
      const baseProvider = evaluator.base_model_provider === 'none' ? undefined : evaluator.base_model_provider
      payload.evaluator = {
        ...evaluator,
        base_model_provider: baseProvider,
        base_model_name: baseProvider ? evaluator.base_model_name : undefined,
        base_model_api_key: baseProvider ? evaluator.base_model_api_key : undefined,
        base_model_base_url: baseProvider ? evaluator.base_model_base_url : undefined,
        graph_rag_config: evaluator.graph_rag_enabled ? evaluator.graph_rag_config : undefined,
      }
    }
    return payload
  }, [selectedStages, graphTraverser, chatml, finetuner, evaluator])

  const handleRun = () => {
    setError(null)
    setRunning(true)
    const config = buildConfig()
    if (setWsEvents && onDone) {
      setWsEvents([])
      setIsConnected?.(undefined) // Reset connection status
      runPipelineViaWebSocket(config as unknown as Record<string, unknown>, {
        onRunId: (id) => onRun(id, config),
        onEvent: (e) => setWsEvents((prev) => [...prev, e]),
        onDone: (r) => {
          setIsConnected?.(false) // Connection closed after done
          onDone(r)
          setRunning(false)
        },
        onError: (msg) => {
          setIsConnected?.(false)
          setError(msg)
          setRunning(false)
        },
        onConnectionChange: (connected) => setIsConnected?.(connected),
      })
      return
    }
    runPipeline(config as unknown as Record<string, unknown>, true)
      .then((res) => {
        if (res.run_id) {
          onRun(res.run_id, config)
        } else {
          setError(res.message || 'Run failed')
        }
      })
      .catch((e) => {
        setError(e instanceof Error ? e.message : 'Failed to run pipeline')
      })
      .finally(() => setRunning(false))
  }

  const handleExport = () => {
    setImportError(null)
    const config = buildConfig()
    const blob = new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = 'pipeline-config.json'
    a.click()
    URL.revokeObjectURL(a.href)
    onExportConfig?.(config)
  }

  const handleImportClick = () => {
    setImportError(null)
    fileInputRef.current?.click()
  }

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      try {
        const text = reader.result as string
        const data = JSON.parse(text) as unknown
        const config = parseImportedConfig(data)
        if (!config) {
          setImportError('Invalid config: need run_stages array with at least one of graph_traverser, chatml_converter, finetuner')
          return
        }
        setSelectedStages(config.run_stages)
        if (config.graph_traverser) {
          const gt = config.graph_traverser
          const def = defaultGraphTraverser
          setGraphTraverser({
            ...def,
            ...gt,
            traversal: { ...defaultTraversal, ...gt.traversal },
            dataset: { ...defaultDataset, ...gt.dataset },
            neo4j: {
              uri: gt.neo4j?.uri ?? def.neo4j!.uri,
              database: gt.neo4j?.database ?? def.neo4j!.database,
              username: gt.neo4j?.username ?? def.neo4j!.username,
              password: gt.neo4j?.password ?? def.neo4j!.password,
            },
            redis: { ...defaultRedis, ...gt.redis },
            llm: { ...defaultLLM, ...gt.llm },
          })
        }
        if (config.chatml_converter) {
          setChatml({ ...defaultChatML, ...config.chatml_converter })
        }
        if (config.finetuner) {
          const allowed = GEMMA_3_MODELS.some((m) => m.value === config.finetuner!.model_name)
            ? config.finetuner.model_name
            : GEMMA_3_MODELS[0].value
          setFinetuner({
            ...defaultFineTuner,
            ...config.finetuner,
            model_name: allowed,
            model_type: 'gemma3',
          })
        }
        if (config.evaluator) {
          setEvaluator({ ...defaultEvaluator, ...config.evaluator })
        }
        setError(null)
        setImportError(null)
      } catch (err) {
        setImportError(err instanceof Error ? err.message : 'Failed to parse config JSON')
      }
    }
    reader.readAsText(file, 'utf-8')
  }

  const selectedOrder = [...selectedStages].sort(
    (a, b) => STAGE_ORDER.indexOf(a) - STAGE_ORDER.indexOf(b)
  )

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Select Pipeline Stages</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            {STAGE_ORDER.map((id, idx) => {
              const active = selectedStages.includes(id)
              return (
                <Button
                  key={id}
                  type="button"
                  variant="outline"
                  onClick={() => toggleStage(id)}
                  className={cn(
                    'h-auto min-w-0 flex flex-col items-stretch p-4 text-left whitespace-normal',
                    active && 'border-primary bg-primary/10',
                  )}
                >
                  <div className="flex items-center justify-between w-full shrink-0">
                    <span
                      className={cn(
                        'w-8 h-8 shrink-0 rounded flex items-center justify-center text-sm font-medium',
                        active ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'
                      )}
                    >
                      {idx + 1}
                    </span>
                    {active && <Check className="h-5 w-5 shrink-0 text-primary" />}
                  </div>
                  <div className="min-w-0 mt-2 flex flex-col gap-0.5">
                    <span className="font-semibold break-words">{STAGE_LABELS[id]}</span>
                    <span className="text-xs text-muted-foreground break-words">
                      {STAGE_DESCRIPTIONS[id]}
                    </span>
                  </div>
                </Button>
              )
            })}
          </div>
        </CardContent>
      </Card>

      {selectedStages.includes('graph_traverser') && (
        <GraphTraverserForm value={graphTraverser} onChange={setGraphTraverser} />
      )}

      {selectedStages.includes('chatml_converter') && (
        <ChatMLConverterForm value={chatml} onChange={setChatml} />
      )}

      {selectedStages.includes('finetuner') && (
        <FineTunerForm value={finetuner} onChange={setFinetuner} />
      )}

      {selectedStages.includes('evaluator') && (
        <EvaluatorForm value={evaluator} onChange={setEvaluator} />
      )}

      <Card>
        <CardHeader>
          <CardTitle>Pipeline Controls</CardTitle>
          <CardDescription>{selectedStages.length} stages selected</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            {selectedOrder.map((id, i) => (
              <span key={id} className="inline-flex items-center gap-1">
                <span className="px-2 py-1 bg-muted rounded text-sm">{STAGE_LABELS[id]}</span>
                {i < selectedOrder.length - 1 && <span className="text-muted-foreground">→</span>}
              </span>
            ))}
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept=".json,application/json"
            className="hidden"
            aria-hidden
            onChange={handleFileChange}
          />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={handleImportClick}>
              <Upload className="h-4 w-4" />
              Import Config
            </Button>
            <Button type="button" variant="outline" onClick={handleExport}>
              <Download className="h-4 w-4" />
              Export Config
            </Button>
            <Button type="button" onClick={handleRun} disabled={running}>
              <Play className="h-4 w-4" />
              Run Pipeline
            </Button>
          </div>
          {importError && (
            <p className="text-sm text-destructive" role="alert">
              {importError}
            </p>
          )}
          {error && (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

function ConfigCollapsible({
  title,
  icon = null,
  children,
  defaultOpen = true,
}: {
  title: string
  icon?: React.ReactNode
  children: React.ReactNode
  defaultOpen?: boolean
}) {
  return (
    <Collapsible defaultOpen={defaultOpen} className="border-b border-border last:border-0">
      <CollapsibleTrigger className="flex w-full items-center gap-2 py-3 text-left font-medium hover:underline [&[data-state=open]>svg]:rotate-180">
        {icon}
        {title}
        <ChevronDown className="h-4 w-4 ml-auto transition-transform" />
      </CollapsibleTrigger>
      <CollapsibleContent className="pb-4">
        {children}
      </CollapsibleContent>
    </Collapsible>
  )
}

function GraphTraverserForm({
  value,
  onChange,
}: {
  value: GraphTraverserConfig
  onChange: (v: GraphTraverserConfig) => void
}) {
  const update = (part: Partial<GraphTraverserConfig>) => onChange({ ...value, ...part })
  const updateTraversal = (t: Partial<GraphTraverserConfig['traversal']>) =>
    update({ traversal: { ...value.traversal, ...t } })
  const updateDataset = (d: Partial<GraphTraverserConfig['dataset']>) =>
    update({ dataset: { ...value.dataset, ...d } })

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <Database className="h-5 w-5 text-muted-foreground" />
          <div>
            <CardTitle>Graph Traverser Configuration</CardTitle>
            <CardDescription>Configure Neo4j connection and traversal settings.</CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        <ConfigCollapsible title="Neo4j Database" icon={<Database className="h-5 w-5 text-muted-foreground" />} defaultOpen>
          <div className="grid grid-cols-2 gap-3">
            <LabelInput label="URI" value={value.neo4j?.uri ?? ''} onChange={(uri) => update({ neo4j: { ...value.neo4j!, uri } })} placeholder="neo4j://localhost:7687" />
            <LabelInput label="Database" value={value.neo4j?.database ?? ''} onChange={(d) => update({ neo4j: { ...value.neo4j!, database: d } })} placeholder="neo4j" />
            <LabelInput label="Username" value={value.neo4j?.username ?? ''} onChange={(u) => update({ neo4j: { ...value.neo4j!, username: u } })} placeholder="neo4j" />
            <LabelInput label="Password" type="password" value={value.neo4j?.password ?? ''} onChange={(p) => update({ neo4j: { ...value.neo4j!, password: p } })} placeholder="••••••••" />
          </div>
        </ConfigCollapsible>
        <ConfigCollapsible title="Redis State Storage" icon={<Database className="h-5 w-5 text-muted-foreground" />} defaultOpen={false}>
          <div className="grid grid-cols-2 gap-3">
            <LabelInput label="Host" value={value.redis?.host ?? ''} onChange={(v) => update({ redis: { ...value.redis!, host: v } })} placeholder="localhost" />
            <LabelInput label="Port" type="number" value={String(value.redis?.port ?? 6379)} onChange={(v) => update({ redis: { ...value.redis!, port: v === '' ? 6379 : parseInt(v, 10) || 6379 } })} placeholder="6379" />
            <LabelInput label="DB" type="number" value={String(value.redis?.db ?? 0)} onChange={(v) => update({ redis: { ...value.redis!, db: v === '' ? 0 : parseInt(v, 10) || 0 } })} placeholder="0" />
            <LabelInput label="Password" type="password" value={value.redis?.password ?? ''} onChange={(p) => update({ redis: { ...value.redis!, password: p } })} placeholder="optional" />
            <LabelInput label="Key prefix" value={value.redis?.key_prefix ?? ''} onChange={(v) => update({ redis: { ...value.redis!, key_prefix: v } })} placeholder="graph_traverser:" />
          </div>
        </ConfigCollapsible>
        <ConfigCollapsible title="LLM Provider" icon={<Globe className="h-5 w-5 text-muted-foreground" />} defaultOpen={false}>
          <div className="space-y-3">
            <div className="space-y-2">
              <Label>Provider</Label>
              <Select value={value.llm?.provider ?? 'openai'} onValueChange={(v) => update({ llm: { ...value.llm!, provider: v } })}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="openai">OpenAI</SelectItem>
                  <SelectItem value="claude">Claude</SelectItem>
                  <SelectItem value="gemini">Gemini</SelectItem>
                  <SelectItem value="ollama">Ollama</SelectItem>
                  <SelectItem value="vllm">vLLM</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {(value.llm?.provider === 'openai' || value.llm?.provider === 'claude') && (
              <>
                <LabelInput label="API Key" type="password" value={value.llm?.api_key ?? ''} onChange={(v) => update({ llm: { ...value.llm!, api_key: v } })} placeholder="sk-..." />
                <LabelInput label="Model" value={value.llm?.model ?? ''} onChange={(v) => update({ llm: { ...value.llm!, model: v } })} placeholder={value.llm?.provider === 'openai' ? 'gpt-4' : 'claude-3-opus-20240229'} />
                {value.llm?.provider === 'openai' && (
                  <LabelInput label="Base URL (optional)" value={value.llm?.base_url ?? ''} onChange={(v) => update({ llm: { ...value.llm!, base_url: v } })} placeholder="https://api.openai.com/v1" />
                )}
              </>
            )}
            {value.llm?.provider === 'gemini' && (
              <>
                <LabelInput label="Project ID" value={value.llm?.project_id ?? ''} onChange={(v) => update({ llm: { ...value.llm!, project_id: v } })} placeholder="my-project" />
                <LabelInput label="Location" value={value.llm?.location ?? ''} onChange={(v) => update({ llm: { ...value.llm!, location: v } })} placeholder="us-central1" />
                <LabelInput label="Model" value={value.llm?.model ?? ''} onChange={(v) => update({ llm: { ...value.llm!, model: v } })} placeholder="gemini-pro" />
                <LabelInput label="Credentials path (optional)" value={value.llm?.credentials_path ?? ''} onChange={(v) => update({ llm: { ...value.llm!, credentials_path: v } })} placeholder="/path/to/key.json" />
              </>
            )}
            {(value.llm?.provider === 'ollama' || value.llm?.provider === 'vllm') && (
              <>
                <LabelInput label="Base URL" value={value.llm?.base_url ?? ''} onChange={(v) => update({ llm: { ...value.llm!, base_url: v } })} placeholder={value.llm?.provider === 'ollama' ? 'http://localhost:11434' : 'http://localhost:8000'} />
                <LabelInput label="Model" value={value.llm?.model ?? ''} onChange={(v) => update({ llm: { ...value.llm!, model: v } })} placeholder={value.llm?.provider === 'ollama' ? 'llama2' : ''} />
              </>
            )}
          </div>
        </ConfigCollapsible>
        <ConfigCollapsible title="Traversal Settings" defaultOpen>
          <div className="space-y-4">
            <div className="grid grid-cols-3 gap-3">
              <div className="space-y-2">
                <Label>Strategy</Label>
                <Select value={value.traversal.strategy} onValueChange={(v) => updateTraversal({ strategy: v })}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {STRATEGY_OPTIONS.map((o) => (
                      <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  {STRATEGY_OPTIONS.find((o) => o.value === value.traversal.strategy)?.description}
                </p>
              </div>
              <LabelInput label="Max Nodes" type="number" value={String(value.traversal.max_nodes)} onChange={(v) => updateTraversal({ max_nodes: parseInt(v, 10) || 0 })} />
              <LabelInput label="Max Depth" type="number" value={String(value.traversal.max_depth)} onChange={(v) => updateTraversal({ max_depth: parseInt(v, 10) || 0 })} />
            </div>
            {value.traversal.strategy === 'reasoning' && (
              <div className="grid grid-cols-2 gap-3">
                <LabelInput
                  label="Reasoning Depth"
                  type="number"
                  value={String(value.traversal.reasoning_depth ?? 2)}
                  onChange={(v) => updateTraversal({ reasoning_depth: parseInt(v, 10) || 2 })}
                  help="Subgraph depth to explore around each node"
                />
                <LabelInput
                  label="Max Paths per Node"
                  type="number"
                  value={String(value.traversal.max_paths_per_node ?? 15)}
                  onChange={(v) => updateTraversal({ max_paths_per_node: parseInt(v, 10) || 15 })}
                  help="Maximum paths to reason over per node"
                />
              </div>
            )}
            {(value.traversal.strategy === 'semantic' || value.traversal.strategy === 'reasoning') && (
              <div className="rounded-lg border bg-muted/50 p-3">
                <p className="text-xs text-muted-foreground">
                  {value.traversal.strategy === 'semantic'
                    ? 'Semantic traversal uses the configured LLM to decide which neighbouring node is most relevant at each step. Ensure an LLM provider is configured above.'
                    : 'Reasoning traversal performs multi-hop subgraph exploration and path analysis using the LLM to generate rich, contextual conversations. Ensure an LLM provider is configured above.'}
                </p>
              </div>
            )}
          </div>
        </ConfigCollapsible>
        <ConfigCollapsible title="Graph Filters (optional)" defaultOpen={false}>
          <div className="space-y-3">
            <LabelInput
              label="Relationship Types"
              value={value.traversal.relationship_types ?? ''}
              onChange={(v) => updateTraversal({ relationship_types: v || undefined })}
              placeholder="HAS_PART, RELATED_TO"
              help="Comma-separated list of relationship types to follow (empty = all)"
            />
            <LabelInput
              label="Node Labels"
              value={value.traversal.node_labels ?? ''}
              onChange={(v) => updateTraversal({ node_labels: v || undefined })}
              placeholder="Person, Organization"
              help="Comma-separated list of node labels to include (empty = all)"
            />
            <LabelInput
              label="Seed Node IDs"
              value={value.traversal.seed_node_ids ?? ''}
              onChange={(v) => updateTraversal({ seed_node_ids: v || undefined })}
              placeholder="node_123, node_456"
              help="Comma-separated starting node IDs (empty = auto-select)"
            />
          </div>
        </ConfigCollapsible>
        <ConfigCollapsible title="Dataset Generation" defaultOpen>
          <div className="space-y-3">
            <div className="space-y-2">
              <Label>Seed Prompts (one per line)</Label>
              <Textarea
                value={(value.dataset.seed_prompts || []).join('\n')}
                onChange={(e) => updateDataset({ seed_prompts: e.target.value.split('\n').filter(Boolean) })}
                rows={3}
                placeholder="What can you tell me about this node? Describe: {properties}"
              />
            </div>
            <LabelInput label="Output Path" value={value.output_path ?? ''} onChange={(v) => update({ output_path: v })} placeholder="output/dataset.jsonl" />
            <div className="flex items-center gap-2">
              <Switch
                id="include_metadata"
                checked={value.dataset.include_metadata}
                onCheckedChange={(checked) => updateDataset({ include_metadata: checked })}
              />
              <Label htmlFor="include_metadata" className="font-normal cursor-pointer">
                Include Metadata — Add node IDs, labels, and depth info
              </Label>
            </div>
          </div>
        </ConfigCollapsible>
      </CardContent>
    </Card>
  )
}

function ChatMLConverterForm({
  value,
  onChange,
}: {
  value: ChatMLConverterConfig
  onChange: (v: ChatMLConverterConfig) => void
}) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <FileText className="h-5 w-5 text-green-600" />
          <div>
            <CardTitle>ChatML Converter Configuration</CardTitle>
            <CardDescription>Normalize and prepare ChatML datasets for fine-tuning</CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <LabelInput label="Input Path" value={value.input_path} onChange={(v) => onChange({ ...value, input_path: v })} placeholder="output/dataset.jsonl" help="Path to ChatML JSONL file (e.g. Graph Traverser output)" />
          <LabelInput label="Output Path" value={value.output_path} onChange={(v) => onChange({ ...value, output_path: v })} placeholder="output/prepared.jsonl" help="Path for prepared dataset (e.g. FineTuner input)" />
        </div>
        <div className="flex items-center gap-2">
          <Switch
            id="prepare_finetuning"
            checked={value.prepare_for_finetuning}
            onCheckedChange={(checked) => onChange({ ...value, prepare_for_finetuning: checked })}
          />
          <Label htmlFor="prepare_finetuning" className="font-normal cursor-pointer">
            Prepare for Fine-tuning — Convert to messages format with proper role structure
          </Label>
        </div>
        <LabelInput label="Chat Template (optional)" value={value.chat_template ?? ''} onChange={(v) => onChange({ ...value, chat_template: v })} placeholder="auto" help="Specific chat template format (leave empty for auto-detection)" />
        <div className="rounded-lg border bg-muted/50 p-3">
          <p className="text-sm font-medium mb-1">Expected Input Format</p>
          <pre className="text-xs text-muted-foreground overflow-x-auto whitespace-pre-wrap">
            {`{"messages": [
  {"role": "system", "content": "..."},
  {"role": "user", "content": "..."},
  {"role": "assistant", "content": "..."}
], "metadata": {...}}`}
          </pre>
        </div>
      </CardContent>
    </Card>
  )
}

function FineTunerForm({
  value,
  onChange,
}: {
  value: FineTunerConfig
  onChange: (v: FineTunerConfig) => void
}) {
  const update = (part: Partial<FineTunerConfig>) => onChange({ ...value, ...part })
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <Cpu className="h-5 w-5 text-amber-600" />
          <div>
            <CardTitle>FineTuner Configuration</CardTitle>
            <CardDescription>
              Fine-tune with Unsloth. Only Gemma 3 models are supported.
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Label>Model (Gemma 3 only)</Label>
          <Select
            value={GEMMA_3_MODELS.some((m) => m.value === value.model_name) ? value.model_name : GEMMA_3_MODELS[0].value}
            onValueChange={(v) => update({ model_name: v, model_type: 'gemma3' })}
          >
            <SelectTrigger>
              <SelectValue placeholder="Select a Gemma 3 model" />
            </SelectTrigger>
            <SelectContent>
              {GEMMA_3_MODELS.map((m) => (
                <SelectItem key={m.value} value={m.value}>
                  {m.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            Unsloth-optimized Gemma 3 instruction-tuned models for fine-tuning.
          </p>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <LabelInput
            label="Train Data Path"
            value={value.train_data_path}
            onChange={(v) => update({ train_data_path: v })}
            placeholder="output/prepared.jsonl"
            help="JSONL with messages (e.g. from ChatML Converter)"
          />
          <LabelInput
            label="Output Directory"
            value={value.output_dir}
            onChange={(v) => update({ output_dir: v })}
            placeholder="output/finetuned"
          />
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <LabelInput
            label="Max Sequence Length"
            type="number"
            value={String(value.max_seq_length ?? 2048)}
            onChange={(v) => update({ max_seq_length: parseInt(v, 10) || 2048 })}
            placeholder="2048"
          />
          <LabelInput
            label="Epochs"
            type="number"
            value={String(value.num_train_epochs ?? 1)}
            onChange={(v) => update({ num_train_epochs: parseInt(v, 10) || 1 })}
            placeholder="1"
          />
          <LabelInput
            label="Batch Size"
            type="number"
            value={String(value.per_device_train_batch_size ?? 2)}
            onChange={(v) => update({ per_device_train_batch_size: parseInt(v, 10) || 2 })}
            placeholder="2"
          />
          <LabelInput
            label="Learning Rate"
            type="text"
            value={String(value.learning_rate ?? 2e-4)}
            onChange={(v) => update({ learning_rate: parseFloat(v) || 2e-4 })}
            placeholder="2e-4"
          />
        </div>
      </CardContent>
    </Card>
  )
}

function EvaluatorForm({
  value,
  onChange,
}: {
  value: EvaluatorConfig
  onChange: (v: EvaluatorConfig) => void
}) {
  const update = (part: Partial<EvaluatorConfig>) => onChange({ ...value, ...part })
  const toggleMetric = (metric: string) => {
    const current = value.metrics || []
    if (current.includes(metric)) {
      update({ metrics: current.filter((m) => m !== metric) })
    } else {
      update({ metrics: [...current, metric] })
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <BarChart3 className="h-5 w-5 text-violet-600" />
          <div>
            <CardTitle>Evaluator Configuration</CardTitle>
            <CardDescription>
              Compare finetuned model against base models and Graph RAG using ROUGE and LLM judge metrics.
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        <ConfigCollapsible title="Evaluation Settings" defaultOpen>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Evaluation Mode</Label>
              <Select value={value.evalg_mode} onValueChange={(v) => update({ evalg_mode: v })}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="internal">Internal (in-process)</SelectItem>
                  <SelectItem value="cli">CLI (external command)</SelectItem>
                  <SelectItem value="noop">No-op (stub report)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <LabelInput
                label="Eval Dataset Path"
                value={value.eval_dataset_path ?? ''}
                onChange={(v) => update({ eval_dataset_path: v })}
                placeholder="output/prepared.jsonl"
                help="JSONL with messages (question/answer pairs)"
              />
              <LabelInput
                label="Output Report Path"
                value={value.output_report_path ?? ''}
                onChange={(v) => update({ output_report_path: v })}
                placeholder="output/eval_report.json"
              />
            </div>
            <LabelInput
              label="Finetuned Model Path (optional)"
              value={value.model_path ?? ''}
              onChange={(v) => update({ model_path: v })}
              placeholder="output/finetuned"
              help="Leave empty to use the finetuner output from context"
            />
            <LabelInput
              label="Max Eval Samples (optional)"
              type="number"
              value={value.max_eval_samples != null ? String(value.max_eval_samples) : ''}
              onChange={(v) => update({ max_eval_samples: v ? parseInt(v, 10) || undefined : undefined })}
              placeholder="All samples"
              help="Limit the number of samples to evaluate"
            />
            <div className="space-y-2">
              <Label>Metrics</Label>
              <div className="flex gap-3">
                {['rouge', 'llm_judge'].map((metric) => (
                  <div key={metric} className="flex items-center gap-2">
                    <Switch
                      id={`metric_${metric}`}
                      checked={(value.metrics || []).includes(metric)}
                      onCheckedChange={() => toggleMetric(metric)}
                    />
                    <Label htmlFor={`metric_${metric}`} className="font-normal cursor-pointer">
                      {metric === 'rouge' ? 'ROUGE (1/2/L)' : 'LLM Judge'}
                    </Label>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </ConfigCollapsible>

        {(value.metrics || []).includes('llm_judge') && (
          <ConfigCollapsible title="LLM Judge" icon={<Globe className="h-5 w-5 text-muted-foreground" />} defaultOpen>
            <div className="space-y-3">
              <div className="space-y-2">
                <Label>Judge Provider</Label>
                <Select value={value.judge_provider ?? 'openai'} onValueChange={(v) => update({ judge_provider: v })}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {LLM_PROVIDERS.map((p) => (
                      <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <LabelInput label="Judge Model" value={value.judge_model ?? ''} onChange={(v) => update({ judge_model: v })} placeholder="gpt-4" />
              <LabelInput label="Judge API Key" type="password" value={value.judge_api_key ?? ''} onChange={(v) => update({ judge_api_key: v })} placeholder="sk-..." />
            </div>
          </ConfigCollapsible>
        )}

        <ConfigCollapsible title="Base Model Comparison (optional)" icon={<Cpu className="h-5 w-5 text-muted-foreground" />} defaultOpen={false}>
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground">
              Add a base (non-finetuned) model to compare against. Leave provider empty to skip.
            </p>
            <div className="space-y-2">
              <Label>Provider</Label>
              <Select value={value.base_model_provider ?? ''} onValueChange={(v) => update({ base_model_provider: v || undefined })}>
                <SelectTrigger>
                  <SelectValue placeholder="None (skip base model)" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">None (skip)</SelectItem>
                  {LLM_PROVIDERS.map((p) => (
                    <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {value.base_model_provider && value.base_model_provider !== 'none' && (
              <>
                <LabelInput label="Model Name" value={value.base_model_name ?? ''} onChange={(v) => update({ base_model_name: v })} placeholder="gemma3:4b" />
                <LabelInput label="API Key" type="password" value={value.base_model_api_key ?? ''} onChange={(v) => update({ base_model_api_key: v })} placeholder="sk-..." />
                <LabelInput label="Base URL (optional)" value={value.base_model_base_url ?? ''} onChange={(v) => update({ base_model_base_url: v })} placeholder="http://localhost:11434" />
              </>
            )}
          </div>
        </ConfigCollapsible>

        <ConfigCollapsible title="Graph RAG Comparison (optional)" icon={<Database className="h-5 w-5 text-muted-foreground" />} defaultOpen={false}>
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <Switch
                id="graph_rag_enabled"
                checked={value.graph_rag_enabled}
                onCheckedChange={(checked) => update({ graph_rag_enabled: checked })}
              />
              <Label htmlFor="graph_rag_enabled" className="font-normal cursor-pointer">
                Include Graph RAG as a comparison system
              </Label>
            </div>
            {value.graph_rag_enabled && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <LabelInput label="Neo4j URI" value={value.graph_rag_config?.neo4j_uri ?? ''} onChange={(v) => update({ graph_rag_config: { ...value.graph_rag_config, neo4j_uri: v } })} placeholder="bolt://localhost:7687" />
                <LabelInput label="Neo4j User" value={value.graph_rag_config?.neo4j_user ?? ''} onChange={(v) => update({ graph_rag_config: { ...value.graph_rag_config, neo4j_user: v } })} placeholder="neo4j" />
                <LabelInput label="Neo4j Password" type="password" value={value.graph_rag_config?.neo4j_password ?? ''} onChange={(v) => update({ graph_rag_config: { ...value.graph_rag_config, neo4j_password: v } })} placeholder="password" />
                <LabelInput label="Neo4j Database" value={value.graph_rag_config?.neo4j_database ?? ''} onChange={(v) => update({ graph_rag_config: { ...value.graph_rag_config, neo4j_database: v } })} placeholder="neo4j" />
                <LabelInput label="LLM API Key" type="password" value={value.graph_rag_config?.llm_api_key ?? ''} onChange={(v) => update({ graph_rag_config: { ...value.graph_rag_config, llm_api_key: v } })} placeholder="sk-..." />
                <LabelInput label="LLM Model" value={value.graph_rag_config?.llm_model ?? ''} onChange={(v) => update({ graph_rag_config: { ...value.graph_rag_config, llm_model: v } })} placeholder="gpt-4" />
              </div>
            )}
          </div>
        </ConfigCollapsible>
      </CardContent>
    </Card>
  )
}

function LabelInput({
  label,
  value,
  onChange,
  type = 'text',
  placeholder,
  help,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  type?: string
  placeholder?: string
  help?: string
}) {
  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      <Input type={type} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} />
      {help && <p className="text-xs text-muted-foreground">{help}</p>}
    </div>
  )
}
