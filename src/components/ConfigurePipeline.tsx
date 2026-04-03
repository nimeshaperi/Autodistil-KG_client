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
import type { PipelineConfigPayload, StageId, GraphTraverserConfig, ChatMLConverterConfig, FineTunerConfig, EvaluatorConfig, RedisConfig, LLMConfig, TraversalConfig, TraversalStrategy, LLMProviderType, EvalMode, GraphRAGConfigRequest } from '@/types/config'
import { STAGE_ORDER, STAGE_LABELS } from '@/types/config'
import { runPipeline, runPipelineViaWebSocket, uploadFile } from '@/api/client'
import type { RunResultResponse, WsRunHandle } from '@/api/client'
import type { WsEvent } from '@/api/client'
import { cn } from '@/lib/utils'

const STAGE_DESCRIPTIONS: Record<StageId, string> = {
  graph_traverser: 'Traverse Neo4j graph and generate conversations',
  chatml_converter: 'Convert and prepare ChatML datasets',
  finetuner: 'Fine-tune models with Unsloth',
  evaluator: 'Compare finetuned vs base models with DeepEval standardised metrics',
}

const STRATEGY_OPTIONS = [
  { value: 'bfs', label: 'Breadth-First Search', description: 'Explore graph layer by layer from seed nodes.' },
  { value: 'dfs', label: 'Depth-First Search', description: 'Explore graph depth-first along each branch.' },
  { value: 'random', label: 'Random Walk', description: 'Randomly select neighbours at each step.' },
  { value: 'semantic', label: 'Semantic (LLM-guided)', description: 'LLM selects the most relevant neighbour based on context.' },
  { value: 'reasoning', label: 'Reasoning (multi-hop)', description: 'Deep multi-hop reasoning with subgraph exploration.' },
]

const defaultTraversal: TraversalConfig = {
  strategy: 'bfs',
  max_nodes: 500,
  max_depth: 5,
  reasoning_depth: 2,
  max_paths_per_node: 15,
  path_batch_size: 5,
  num_workers: 1,
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

const defaultAlignment: GraphTraverserConfig['alignment'] = {
  quality_filter: false,
  quality_threshold: 0.7,
}

const defaultGraphTraverser: GraphTraverserConfig = {
  output_path: 'output/dataset.jsonl',
  traversal: defaultTraversal,
  dataset: defaultDataset,
  alignment: defaultAlignment,
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

// Supported model families for Unsloth finetuning
const FINETUNE_MODELS: { family: string; type: string; models: { value: string; label: string }[] }[] = [
  {
    family: 'Gemma 3',
    type: 'gemma3',
    models: [
      { value: 'unsloth/gemma-3-270m-it', label: 'Gemma 3 270M' },
      { value: 'unsloth/gemma-3-1b-it', label: 'Gemma 3 1B' },
      { value: 'unsloth/gemma-3-4b-it', label: 'Gemma 3 4B' },
    ],
  },
  {
    family: 'Qwen 3',
    type: 'qwen3',
    models: [
      { value: 'unsloth/Qwen3-0.6B', label: 'Qwen 3 0.6B' },
      { value: 'unsloth/Qwen3-1.7B', label: 'Qwen 3 1.7B' },
      { value: 'unsloth/Qwen3-4B', label: 'Qwen 3 4B' },
      { value: 'unsloth/Qwen3-8B', label: 'Qwen 3 8B' },
    ],
  },
  {
    family: 'Qwen 3.5',
    type: 'qwen3_5',
    models: [
      { value: 'unsloth/Qwen3.5-0.8B', label: 'Qwen 3.5 0.8B' },
      { value: 'unsloth/Qwen3.5-2B', label: 'Qwen 3.5 2B' },
      { value: 'unsloth/Qwen3.5-4B', label: 'Qwen 3.5 4B' },
      { value: 'unsloth/Qwen3.5-9B', label: 'Qwen 3.5 9B' },
    ],
  },
  {
    family: 'Llama 3',
    type: 'llama3',
    models: [
      { value: 'unsloth/Llama-3.2-1B-Instruct', label: 'Llama 3.2 1B' },
      { value: 'unsloth/Llama-3.2-3B-Instruct', label: 'Llama 3.2 3B' },
    ],
  },
]

const ALL_MODELS = FINETUNE_MODELS.flatMap((f) => f.models.map((m) => ({ ...m, type: f.type, family: f.family })))

// Models available for vLLM serving / base model evaluation (HuggingFace IDs, Qwen + Gemma only, <=10B)
const LOCAL_SERVING_MODELS: { family: string; models: { value: string; label: string }[] }[] = [
  {
    family: 'Qwen 3.5',
    models: [
      { value: 'Qwen/Qwen3.5-0.8B', label: 'Qwen 3.5 0.8B' },
      { value: 'Qwen/Qwen3.5-2B', label: 'Qwen 3.5 2B' },
      { value: 'Qwen/Qwen3.5-4B', label: 'Qwen 3.5 4B' },
      { value: 'Qwen/Qwen3.5-9B', label: 'Qwen 3.5 9B' },
    ],
  },
  {
    family: 'Qwen 3',
    models: [
      { value: 'Qwen/Qwen3-0.6B', label: 'Qwen 3 0.6B' },
      { value: 'Qwen/Qwen3-1.7B', label: 'Qwen 3 1.7B' },
      { value: 'Qwen/Qwen3-4B', label: 'Qwen 3 4B' },
      { value: 'Qwen/Qwen3-8B', label: 'Qwen 3 8B' },
    ],
  },
  {
    family: 'Gemma 3',
    models: [
      { value: 'google/gemma-3-1b-it', label: 'Gemma 3 1B' },
      { value: 'google/gemma-3-4b-it', label: 'Gemma 3 4B' },
    ],
  },
]

/** Reusable dropdown for selecting a local model (Qwen/Gemma, <=10B). */
function ModelSelector({
  value,
  onChange,
  models = LOCAL_SERVING_MODELS,
  label = 'Model',
  placeholder = 'Select a model',
  help,
}: {
  value: string
  onChange: (v: string) => void
  models?: typeof LOCAL_SERVING_MODELS
  label?: string
  placeholder?: string
  help?: string
}) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger>
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>
          {models.map((family) => (
            <div key={family.family}>
              <div className="px-2 py-1.5 text-xs font-semibold text-muted-foreground">{family.family}</div>
              {family.models.map((m) => (
                <SelectItem key={m.value} value={m.value}>{m.label}</SelectItem>
              ))}
            </div>
          ))}
        </SelectContent>
      </Select>
      {help && <p className="text-xs text-muted-foreground">{help}</p>}
    </div>
  )
}

function inferModelType(modelName: string): string {
  const entry = ALL_MODELS.find((m) => m.value === modelName)
  if (entry) return entry.type
  const n = modelName.toLowerCase()
  if (n.includes('qwen3.5') || n.includes('qwen3_5')) return 'qwen3_5'
  if (n.includes('qwen3')) return 'qwen3'
  if (n.includes('qwen')) return 'qwen2'
  if (n.includes('gemma')) return 'gemma3'
  if (n.includes('llama')) return 'llama3'
  return 'chatml'
}

const defaultFineTuner: FineTunerConfig = {
  model_name: ALL_MODELS[0].value,
  model_type: ALL_MODELS[0].type,
  train_data_path: 'output/prepared.jsonl',
  output_dir: 'output/finetuned',
  max_seq_length: 2048,
  num_train_epochs: 1,
  per_device_train_batch_size: 2,
  learning_rate: 2e-4,
}

const LLM_PROVIDERS = [
  { value: 'openai', label: 'OpenAI' },
  { value: 'openai_compatible', label: 'OpenAI Compatible' },
  { value: 'claude', label: 'Claude' },
  { value: 'gemini', label: 'Gemini' },
  { value: 'ollama', label: 'Ollama' },
  { value: 'vllm', label: 'vLLM' },
] as const

const defaultEvaluator: EvaluatorConfig = {
  eval_dataset_path: 'output/prepared.jsonl',
  output_report_path: 'output/eval_report.json',
  metrics: ['answer_relevancy'],
  evalg_mode: 'internal',
  graph_rag_enabled: false,
  use_vllm: false,
  vllm_gpu_memory_utilization: 0.9,
}

interface ConfigurePipelineProps {
  onRun: (runId: string, config: PipelineConfigPayload) => void
  onExportConfig?: (config: PipelineConfigPayload) => void
  setWsEvents?: React.Dispatch<React.SetStateAction<WsEvent[]>>
  setIsConnected?: React.Dispatch<React.SetStateAction<boolean | undefined>>
  onDone?: (result: RunResultResponse) => void
  setWsHandle?: (handle: WsRunHandle | null) => void
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
      ? (o.graph_traverser as PipelineConfigPayload['graph_traverser'])
      : undefined,
    chatml_converter: o.chatml_converter && typeof o.chatml_converter === 'object'
      ? (o.chatml_converter as ChatMLConverterConfig)
      : undefined,
    finetuner: o.finetuner && typeof o.finetuner === 'object'
      ? (o.finetuner as FineTunerConfig)
      : undefined,
    evaluator: o.evaluator && typeof o.evaluator === 'object'
      ? (o.evaluator as PipelineConfigPayload['evaluator'])
      : undefined,
  }
}

export default function ConfigurePipeline({ onRun, onExportConfig, setWsEvents, setIsConnected, onDone, setWsHandle }: ConfigurePipelineProps) {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [selectedStages, setSelectedStages] = useState<StageId[]>(['graph_traverser', 'chatml_converter'])
  const [graphTraverser, setGraphTraverser] = useState<GraphTraverserConfig>(defaultGraphTraverser)
  const [chatml, setChatml] = useState<ChatMLConverterConfig>(defaultChatML)
  const [finetuner, setFinetuner] = useState<FineTunerConfig>(defaultFineTuner)
  const [evaluator, setEvaluator] = useState<EvaluatorConfig>(defaultEvaluator)
  const [logLevel, setLogLevel] = useState<import('@/types/config').LogLevel>('INFO')
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
      log_level: logLevel,
    }
    if (selectedStages.includes('graph_traverser')) {
      const csvToArray = (v?: string) => v ? v.split(',').map((s) => s.trim()).filter(Boolean) : undefined
      const t = graphTraverser.traversal
      const a = graphTraverser.alignment
      const hasAlignment = a && (a.domain_focus || a.domain_keywords || a.style_guide || a.target_audience || a.quality_filter || a.reference_texts_path)
      payload.graph_traverser = {
        ...graphTraverser,
        output_path: graphTraverser.output_path || 'output/dataset.jsonl',
        traversal: {
          strategy: t.strategy,
          max_nodes: t.max_nodes,
          max_depth: t.max_depth,
          reasoning_depth: t.reasoning_depth ?? 2,
          max_paths_per_node: t.max_paths_per_node ?? 15,
          path_batch_size: t.path_batch_size ?? 5,
          num_workers: t.num_workers ?? 1,
          relationship_types: csvToArray(t.relationship_types),
          node_labels: csvToArray(t.node_labels),
          seed_node_ids: csvToArray(t.seed_node_ids),
        },
        dataset: {
          ...graphTraverser.dataset,
          seed_prompts: graphTraverser.dataset.seed_prompts.filter(Boolean),
          output_format: graphTraverser.dataset.output_format ?? 'jsonl',
        },
        alignment: hasAlignment ? {
          domain_focus: a!.domain_focus || undefined,
          domain_keywords: a!.domain_keywords ? a!.domain_keywords.split(',').map(s => s.trim()).filter(Boolean) : undefined,
          style_guide: a!.style_guide || undefined,
          target_audience: a!.target_audience || undefined,
          max_answer_length: a!.max_answer_length || undefined,
          min_answer_length: a!.min_answer_length || undefined,
          quality_filter: a!.quality_filter,
          quality_threshold: a!.quality_filter ? a!.quality_threshold : undefined,
          reference_texts_path: a!.reference_texts_path || undefined,
        } : undefined,
      }
    }
    if (selectedStages.includes('chatml_converter')) {
      payload.chatml_converter = { ...chatml }
    }
    if (selectedStages.includes('finetuner')) {
      payload.finetuner = {
        ...finetuner,
        model_type: inferModelType(finetuner.model_name),
      }
    }
    if (selectedStages.includes('evaluator')) {
      const baseProvider = (!evaluator.base_model_provider || evaluator.base_model_provider === 'none') ? undefined : evaluator.base_model_provider
      // base_model_name is needed by both base model comparison AND vLLM serving
      const needsBaseName = baseProvider || evaluator.use_vllm
      payload.evaluator = {
        ...evaluator,
        base_model_provider: baseProvider,
        base_model_name: needsBaseName ? evaluator.base_model_name : undefined,
        base_model_api_key: baseProvider ? evaluator.base_model_api_key : undefined,
        base_model_base_url: baseProvider ? evaluator.base_model_base_url : undefined,
        graph_rag_config: evaluator.graph_rag_enabled ? evaluator.graph_rag_config as GraphRAGConfigRequest : undefined,
        use_vllm: evaluator.use_vllm,
        vllm_gpu_memory_utilization: evaluator.use_vllm ? evaluator.vllm_gpu_memory_utilization : undefined,
        vllm_max_model_len: evaluator.use_vllm ? evaluator.vllm_max_model_len : undefined,
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
      const handle = runPipelineViaWebSocket(config, {
        onRunId: (id) => onRun(id, config),
        onEvent: (e) => setWsEvents((prev) => [...prev, e]),
        onDone: (r) => {
          setIsConnected?.(false) // Connection closed after done
          setWsHandle?.(null)
          onDone(r)
          setRunning(false)
        },
        onError: (msg) => {
          setIsConnected?.(false)
          setWsHandle?.(null)
          setError(msg)
          setRunning(false)
        },
        onConnectionChange: (connected) => setIsConnected?.(connected),
      })
      setWsHandle?.(handle)
      return
    }
    runPipeline(config, true)
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
            traversal: {
              ...defaultTraversal,
              ...gt.traversal,
              // Imported JSON has string[] but form state uses CSV strings
              relationship_types: Array.isArray(gt.traversal?.relationship_types) ? gt.traversal.relationship_types.join(', ') : gt.traversal?.relationship_types,
              node_labels: Array.isArray(gt.traversal?.node_labels) ? gt.traversal.node_labels.join(', ') : gt.traversal?.node_labels,
              seed_node_ids: Array.isArray(gt.traversal?.seed_node_ids) ? gt.traversal.seed_node_ids.join(', ') : gt.traversal?.seed_node_ids,
            },
            dataset: { ...defaultDataset, ...gt.dataset },
            alignment: gt.alignment ? {
              ...gt.alignment,
              quality_filter: gt.alignment.quality_filter ?? false,
              quality_threshold: gt.alignment.quality_threshold ?? 0.7,
              domain_keywords: Array.isArray(gt.alignment.domain_keywords) ? gt.alignment.domain_keywords.join(', ') : gt.alignment.domain_keywords,
            } : undefined,
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
          const modelName = config.finetuner.model_name || defaultFineTuner.model_name
          setFinetuner({
            ...defaultFineTuner,
            ...config.finetuner,
            model_name: modelName,
            model_type: inferModelType(modelName),
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
        <>
          {!selectedStages.includes('graph_traverser') && (
            <StandaloneHint stage="ChatML Converter" inputLabel="Input Path" inputField="input_path" />
          )}
          <ChatMLConverterForm value={chatml} onChange={setChatml} />
        </>
      )}

      {selectedStages.includes('finetuner') && (
        <>
          {!selectedStages.includes('chatml_converter') && (
            <StandaloneHint stage="FineTuner" inputLabel="Train Data Path" inputField="train_data_path" />
          )}
          <FineTunerForm value={finetuner} onChange={setFinetuner} />
        </>
      )}

      {selectedStages.includes('evaluator') && (
        <>
          {!selectedStages.includes('finetuner') && (
            <StandaloneHint stage="Evaluator" inputLabel="Model Path & Eval Dataset Path" inputField="model_path" />
          )}
          <EvaluatorForm value={evaluator} onChange={setEvaluator} inferredModelPath={selectedStages.includes('finetuner') ? (finetuner.output_dir || 'output/finetuned') : undefined} />
        </>
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
          <div className="flex justify-end gap-2 items-center">
            <div className="flex items-center gap-1.5 mr-auto">
              <Label className="text-xs text-muted-foreground">Log Level</Label>
              <Select value={logLevel} onValueChange={(v) => setLogLevel(v as import('@/types/config').LogLevel)}>
                <SelectTrigger className="h-8 w-28 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="DEBUG">Debug</SelectItem>
                  <SelectItem value="INFO">Info</SelectItem>
                  <SelectItem value="WARNING">Warning</SelectItem>
                  <SelectItem value="ERROR">Error</SelectItem>
                </SelectContent>
              </Select>
            </div>
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
  const updateAlignment = (a: Partial<NonNullable<GraphTraverserConfig['alignment']>>) =>
    update({ alignment: { quality_filter: false, quality_threshold: 0.7, ...value.alignment, ...a } })

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
              <Select value={value.llm?.provider ?? 'openai'} onValueChange={(v) => update({ llm: { ...value.llm!, provider: v as LLMProviderType } })}>
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
            <div className="grid grid-cols-4 gap-3">
              <div className="space-y-2">
                <Label>Strategy</Label>
                <Select value={value.traversal.strategy} onValueChange={(v) => updateTraversal({ strategy: v as TraversalStrategy })}>
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
              <LabelInput
                label="Workers"
                type="number"
                value={String(value.traversal.num_workers ?? 1)}
                onChange={(v) => updateTraversal({ num_workers: Math.max(1, parseInt(v, 10) || 1) })}
                help="Parallel traversal workers (1 = sequential)"
              />
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
                <LabelInput
                  label="Path Batch Size"
                  type="number"
                  value={String(value.traversal.path_batch_size ?? 5)}
                  onChange={(v) => updateTraversal({ path_batch_size: parseInt(v, 10) || 5 })}
                  help="Paths per LLM call (higher = fewer calls, faster)"
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
        <ConfigCollapsible title="Alignment (optional)" defaultOpen={false}>
          <div className="space-y-4">
            <div className="rounded-lg border bg-muted/50 p-3">
              <p className="text-xs text-muted-foreground">
                Steer generated training data toward a specific domain, style, or quality bar. All fields are optional.
              </p>
            </div>
            {/* Domain alignment */}
            <div className="space-y-3">
              <p className="text-sm font-medium">Domain Focus</p>
              <LabelInput
                label="Domain"
                value={value.alignment?.domain_focus ?? ''}
                onChange={(v) => updateAlignment({ domain_focus: v || undefined })}
                placeholder="e.g. clinical pharmacology and drug interactions"
                help="Free-text description of the target domain. Injected into all generation prompts."
              />
              <LabelInput
                label="Keywords"
                value={value.alignment?.domain_keywords ?? ''}
                onChange={(v) => updateAlignment({ domain_keywords: v || undefined })}
                placeholder="pharmacology, drug, enzyme, receptor"
                help="Comma-separated keywords that bias node selection and path priority."
              />
            </div>
            {/* Style alignment */}
            <div className="space-y-3">
              <p className="text-sm font-medium">Style &amp; Audience</p>
              <LabelInput
                label="Target Audience"
                value={value.alignment?.target_audience ?? ''}
                onChange={(v) => updateAlignment({ target_audience: v || undefined })}
                placeholder="e.g. medical students, senior engineers"
                help="Included in the system message for generated training data."
              />
              <div className="space-y-2">
                <Label>Style Guide</Label>
                <Textarea
                  value={value.alignment?.style_guide ?? ''}
                  onChange={(e) => updateAlignment({ style_guide: e.target.value || undefined })}
                  rows={2}
                  placeholder="e.g. Use concise bullet points suitable for a clinical reference card"
                />
                <p className="text-xs text-muted-foreground">Prose instructions for answer tone and format.</p>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <LabelInput
                  label="Min Answer Length (words)"
                  type="number"
                  value={value.alignment?.min_answer_length != null ? String(value.alignment.min_answer_length) : ''}
                  onChange={(v) => updateAlignment({ min_answer_length: v ? parseInt(v, 10) || undefined : undefined })}
                  placeholder="optional"
                />
                <LabelInput
                  label="Max Answer Length (words)"
                  type="number"
                  value={value.alignment?.max_answer_length != null ? String(value.alignment.max_answer_length) : ''}
                  onChange={(v) => updateAlignment({ max_answer_length: v ? parseInt(v, 10) || undefined : undefined })}
                  placeholder="optional"
                />
              </div>
            </div>
            {/* Quality alignment */}
            <div className="space-y-3">
              <p className="text-sm font-medium">Quality Filter</p>
              <div className="flex items-center gap-2">
                <Switch
                  id="quality_filter"
                  checked={value.alignment?.quality_filter ?? false}
                  onCheckedChange={(checked) => updateAlignment({ quality_filter: checked })}
                />
                <Label htmlFor="quality_filter" className="font-normal cursor-pointer">
                  Enable quality gate — LLM scores each Q&amp;A pair and discards low-quality ones
                </Label>
              </div>
              {value.alignment?.quality_filter && (
                <LabelInput
                  label="Quality Threshold (0–1)"
                  type="number"
                  value={String(value.alignment?.quality_threshold ?? 0.7)}
                  onChange={(v) => updateAlignment({ quality_threshold: Math.max(0, Math.min(1, parseFloat(v) || 0.7)) })}
                  help="Minimum average score (relevance, groundedness, completeness) to keep a pair."
                />
              )}
            </div>
            {/* Reference alignment */}
            <div className="space-y-3">
              <p className="text-sm font-medium">Reference Grounding</p>
              <LabelInput
                label="Reference Texts Path"
                value={value.alignment?.reference_texts_path ?? ''}
                onChange={(v) => updateAlignment({ reference_texts_path: v || undefined })}
                placeholder="path/to/reference.txt or reference.jsonl"
                help="Path to plain-text or JSONL reference material. Relevant excerpts are injected into prompts for grounding."
              />
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
          <FileText className="h-5 w-5 text-primary" />
          <div>
            <CardTitle>ChatML Converter Configuration</CardTitle>
            <CardDescription>Normalize and prepare ChatML datasets for fine-tuning</CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <PathInputWithUpload label="Input Path" value={value.input_path ?? ''} onChange={(v) => onChange({ ...value, input_path: v })} placeholder="output/dataset.jsonl" help="Path to ChatML JSONL file — type a path or upload" />
          <LabelInput label="Output Path" value={value.output_path ?? ''} onChange={(v) => onChange({ ...value, output_path: v })} placeholder="output/prepared.jsonl" help="Path for prepared dataset (e.g. FineTuner input)" />
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

function StandaloneHint({ stage, inputLabel }: { stage: string; inputLabel: string; inputField?: string }) {
  return (
    <div className="rounded-lg border border-primary/30 bg-primary/5 dark:bg-primary/10 dark:border-primary/20 px-4 py-3 text-sm text-foreground">
      <span className="font-medium">Standalone mode:</span> {stage} is running without its predecessor.
      Make sure <span className="font-medium">{inputLabel}</span> is set to an existing file from a previous run.
    </div>
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
          <Cpu className="h-5 w-5 text-primary" />
          <div>
            <CardTitle>FineTuner Configuration</CardTitle>
            <CardDescription>
              Fine-tune with Unsloth — Gemma, Qwen, Llama models supported.
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Label>Model</Label>
          <Select
            value={value.model_name}
            onValueChange={(v) => update({ model_name: v, model_type: inferModelType(v) })}
          >
            <SelectTrigger>
              <SelectValue placeholder="Select a model" />
            </SelectTrigger>
            <SelectContent>
              {FINETUNE_MODELS.map((family) => (
                <div key={family.family}>
                  <div className="px-2 py-1.5 text-xs font-semibold text-muted-foreground">{family.family}</div>
                  {family.models.map((m) => (
                    <SelectItem key={m.value} value={m.value}>
                      {m.label}
                    </SelectItem>
                  ))}
                </div>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            Unsloth-optimized models for fine-tuning.
          </p>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <PathInputWithUpload
            label="Train Data Path"
            value={value.train_data_path ?? ''}
            onChange={(v) => update({ train_data_path: v })}
            placeholder="output/prepared.jsonl"
            help="JSONL with messages — type a path or upload"
          />
          <LabelInput
            label="Output Directory"
            value={value.output_dir ?? ''}
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
  inferredModelPath,
}: {
  value: EvaluatorConfig
  onChange: (v: EvaluatorConfig) => void
  inferredModelPath?: string
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

  const hasFinetuned = !!(value.model_path || inferredModelPath)
  const hasBaseModel = value.base_model_provider && value.base_model_provider !== 'none'
  const hasGraphRag = value.graph_rag_enabled
  const systemCount = (hasFinetuned ? 1 : 0) + (hasBaseModel ? 1 : 0) + (hasGraphRag ? 1 : 0)

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <BarChart3 className="h-5 w-5 text-primary" />
          <div>
            <CardTitle>Evaluator Configuration</CardTitle>
            <CardDescription>
              Select which systems to evaluate and configure scoring metrics. {systemCount} system{systemCount !== 1 ? 's' : ''} selected.
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-2">

        {/* ─── SYSTEMS TO EVALUATE ─── */}
        <ConfigCollapsible title={`Evaluation Systems (${systemCount})`} defaultOpen>
          <div className="space-y-4">
            <p className="text-xs text-muted-foreground">
              Each enabled system generates predictions for every eval sample. Results are compared side-by-side in the report.
            </p>

            {/* vLLM banner */}
            <div className={`rounded-lg border px-3 py-2.5 space-y-2.5 ${value.use_vllm ? 'border-primary/30 bg-primary/5' : ''}`}>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Cpu className="h-4 w-4 text-muted-foreground" />
                  <div>
                    <span className="text-sm font-medium">vLLM Serving</span>
                    <p className="text-[11px] text-muted-foreground">
                      {value.use_vllm
                        ? 'Base model + LoRA adapter served on a single vLLM server'
                        : 'Off — models load/unload sequentially via Unsloth'}
                    </p>
                  </div>
                </div>
                <Switch checked={value.use_vllm} onCheckedChange={(v) => update({ use_vllm: v })} />
              </div>
              {value.use_vllm && (
                <ModelSelector
                  value={value.base_model_name ?? ''}
                  onChange={(v) => update({ base_model_name: v })}
                  label="Base Model"
                  help="The model vLLM will load. LoRA adapter from finetuner runs on top of this."
                />
              )}
            </div>

            {/* System 1: Finetuned */}
            <div className={`rounded-lg border p-3 space-y-3 ${(value.model_path || inferredModelPath) ? '' : 'opacity-60'}`}>
              <div className="flex items-center gap-2">
                <div className={`h-2.5 w-2.5 rounded-full ${(value.model_path || inferredModelPath) ? 'bg-primary' : 'bg-muted-foreground/30'}`} />
                <span className="text-sm font-medium">Finetuned Model</span>
                {inferredModelPath && !value.model_path && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-primary/10 text-primary font-medium">Auto from finetuner</span>
                )}
                {!inferredModelPath && !value.model_path && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground font-medium">No model — will skip</span>
                )}
              </div>
              <LabelInput
                label="Model Path"
                value={value.model_path ?? ''}
                onChange={(v) => update({ model_path: v })}
                placeholder={inferredModelPath ?? 'output/finetuned'}
                help={inferredModelPath ? `Will use finetuner output: ${inferredModelPath}` : 'Leave empty to skip finetuned model evaluation'}
              />
            </div>

            {/* System 2: Base Model */}
            <div className={`rounded-lg border p-3 space-y-3 ${hasBaseModel ? '' : 'opacity-60'}`}>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <div className={`h-2.5 w-2.5 rounded-full ${hasBaseModel ? 'bg-blue-500' : 'bg-muted-foreground/30'}`} />
                  <span className="text-sm font-medium">Base Model</span>
                </div>
                <Select value={value.base_model_provider ?? 'none'} onValueChange={(v) => update({ base_model_provider: (v as LLMProviderType | 'local' | 'none') || undefined })}>
                  <SelectTrigger className="w-44 h-8 text-xs">
                    <SelectValue placeholder="Disabled" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Disabled</SelectItem>
                    <SelectItem value="local">Local (same GPU)</SelectItem>
                    {LLM_PROVIDERS.map((p) => (
                      <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {hasBaseModel && (
                value.base_model_provider === 'local' ? (
                  <ModelSelector
                    value={value.base_model_name ?? ''}
                    onChange={(v) => update({ base_model_name: v })}
                    label="Model"
                    help={value.use_vllm ? 'Will be served via vLLM alongside the LoRA adapter' : 'Loaded via Unsloth after finetuned model is unloaded'}
                  />
                ) : (
                  <LLMProviderFields
                    provider={value.base_model_provider as LLMProviderType}
                    model={value.base_model_name}
                    apiKey={value.base_model_api_key}
                    baseUrl={value.base_model_base_url}
                    onProviderChange={(v) => update({ base_model_provider: (v as LLMProviderType | 'none') || undefined })}
                    onModelChange={(v) => update({ base_model_name: v })}
                    onApiKeyChange={(v) => update({ base_model_api_key: v })}
                    onBaseUrlChange={(v) => update({ base_model_base_url: v })}
                    modelPlaceholder="gemma3:4b"
                  />
                )
              )}
            </div>

            {/* System 3: Graph RAG */}
            <div className={`rounded-lg border p-3 space-y-3 ${hasGraphRag ? '' : 'opacity-60'}`}>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <div className={`h-2.5 w-2.5 rounded-full ${hasGraphRag ? 'bg-emerald-500' : 'bg-muted-foreground/30'}`} />
                  <span className="text-sm font-medium">Graph RAG</span>
                </div>
                <Switch
                  checked={value.graph_rag_enabled}
                  onCheckedChange={(checked) => update({ graph_rag_enabled: checked })}
                />
              </div>
              {hasGraphRag && (
                <div className="space-y-4">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <LabelInput label="Neo4j URI" value={value.graph_rag_config?.neo4j_uri ?? ''} onChange={(v) => update({ graph_rag_config: { ...value.graph_rag_config, neo4j_uri: v } })} placeholder="bolt://localhost:7688" />
                    <LabelInput label="Neo4j User" value={value.graph_rag_config?.neo4j_user ?? ''} onChange={(v) => update({ graph_rag_config: { ...value.graph_rag_config, neo4j_user: v } })} placeholder="neo4j" />
                    <LabelInput label="Neo4j Password" type="password" value={value.graph_rag_config?.neo4j_password ?? ''} onChange={(v) => update({ graph_rag_config: { ...value.graph_rag_config, neo4j_password: v } })} placeholder="" />
                    <LabelInput label="Neo4j Database" value={value.graph_rag_config?.neo4j_database ?? ''} onChange={(v) => update({ graph_rag_config: { ...value.graph_rag_config, neo4j_database: v } })} placeholder="neo4j" />
                  </div>
                  {value.use_vllm ? (
                    <div className="rounded border border-primary/20 bg-primary/5 px-3 py-2">
                      <p className="text-xs font-medium text-primary">LLM: Using local vLLM server</p>
                      <p className="text-[11px] text-muted-foreground">
                        Graph RAG will use the same vLLM-hosted model ({value.base_model_name || 'base model'}) for entity extraction and answer synthesis.
                      </p>
                    </div>
                  ) : (
                    <div className="space-y-1">
                      <Label className="text-sm font-medium">LLM</Label>
                      <LLMProviderFields
                        provider={value.graph_rag_config?.llm_provider}
                        model={value.graph_rag_config?.llm_model}
                        apiKey={value.graph_rag_config?.llm_api_key}
                        baseUrl={value.graph_rag_config?.llm_base_url}
                        onProviderChange={(v) => update({ graph_rag_config: { ...value.graph_rag_config, llm_provider: v as LLMProviderType } })}
                        onModelChange={(v) => update({ graph_rag_config: { ...value.graph_rag_config, llm_model: v } })}
                        onApiKeyChange={(v) => update({ graph_rag_config: { ...value.graph_rag_config, llm_api_key: v } })}
                        onBaseUrlChange={(v) => update({ graph_rag_config: { ...value.graph_rag_config, llm_base_url: v } })}
                      />
                    </div>
                  )}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <LabelInput label="Embedding API Key" type="password" value={value.graph_rag_config?.embedding_api_key ?? ''} onChange={(v) => update({ graph_rag_config: { ...value.graph_rag_config, embedding_api_key: v } })} placeholder="(defaults to LLM key)" />
                    <LabelInput label="Embedding Model" value={value.graph_rag_config?.embedding_model ?? ''} onChange={(v) => update({ graph_rag_config: { ...value.graph_rag_config, embedding_model: v } })} placeholder="text-embedding-3-small" />
                    <LabelInput label="Embedding Base URL" value={value.graph_rag_config?.embedding_base_url ?? ''} onChange={(v) => update({ graph_rag_config: { ...value.graph_rag_config, embedding_base_url: v } })} placeholder="(defaults to OpenAI)" help="Custom endpoint for embeddings" />
                  </div>
                </div>
              )}
            </div>
          </div>
        </ConfigCollapsible>

        {/* ─── INFERENCE SETTINGS ─── */}
        <ConfigCollapsible title="Inference Settings" icon={<Cpu className="h-5 w-5 text-muted-foreground" />} defaultOpen={value.use_vllm}>
          <div className="space-y-3">
            {value.use_vllm && (
              <div className="space-y-3">
                <p className="text-xs text-muted-foreground">
                  vLLM will auto-start with the base model + LoRA adapter before evaluation and stop after.
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <LabelInput
                    label="GPU Memory Utilization"
                    value={String(value.vllm_gpu_memory_utilization ?? 0.9)}
                    onChange={(v) => update({ vllm_gpu_memory_utilization: parseFloat(v) || 0.9 })}
                    placeholder="0.9"
                    help="Fraction of GPU memory (0.0-1.0)"
                  />
                  <LabelInput
                    label="Max Model Length"
                    value={value.vllm_max_model_len != null ? String(value.vllm_max_model_len) : ''}
                    onChange={(v) => update({ vllm_max_model_len: v ? parseInt(v) : undefined })}
                    placeholder="Auto-detect"
                    help="Override context length (leave empty for auto)"
                  />
                </div>
              </div>
            )}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <LabelInput
                label="Max New Tokens"
                type="number"
                value={String(value.max_new_tokens ?? 2048)}
                onChange={(v) => update({ max_new_tokens: Math.max(1, parseInt(v, 10) || 2048) })}
                placeholder="2048"
                help="Max tokens per response"
              />
              <LabelInput
                label="Max Seq Length"
                type="number"
                value={String(value.max_seq_length ?? 4096)}
                onChange={(v) => update({ max_seq_length: Math.max(1, parseInt(v, 10) || 4096) })}
                placeholder="4096"
                help="Context window size"
              />
            </div>
          </div>
        </ConfigCollapsible>

        {/* ─── SCORING ─── */}
        <ConfigCollapsible title="Scoring Metrics" defaultOpen>
          <div className="space-y-4">
            <div className="space-y-2">
              <div className="flex flex-wrap gap-3">
                {([
                  { id: 'answer_relevancy', label: 'Answer Relevancy' },
                  { id: 'correctness', label: 'Correctness (G-Eval)' },
                  { id: 'faithfulness', label: 'Faithfulness' },
                  { id: 'hallucination', label: 'Hallucination' },
                  { id: 'grounding', label: 'Grounding (G-Eval)' },
                ] as const).map(({ id, label }) => (
                  <div key={id} className="flex items-center gap-2">
                    <Switch
                      id={`metric_${id}`}
                      checked={(value.metrics || []).includes(id)}
                      onCheckedChange={() => toggleMetric(id)}
                    />
                    <Label htmlFor={`metric_${id}`} className="font-normal cursor-pointer text-sm">
                      {label}
                    </Label>
                  </div>
                ))}
              </div>
            </div>
            {(value.metrics || []).length > 0 && (
              <div className="space-y-2">
                <Label className="text-sm font-medium">LLM Judge</Label>
                <p className="text-xs text-muted-foreground">The LLM used to score predictions against references.</p>
                <LLMProviderFields
                  provider={value.judge_provider}
                  model={value.judge_model}
                  apiKey={value.judge_api_key}
                  baseUrl={value.judge_base_url}
                  onProviderChange={(v) => update({ judge_provider: v as LLMProviderType })}
                  onModelChange={(v) => update({ judge_model: v })}
                  onApiKeyChange={(v) => update({ judge_api_key: v })}
                  onBaseUrlChange={(v) => update({ judge_base_url: v })}
                />
              </div>
            )}
          </div>
        </ConfigCollapsible>

        {/* ─── DATASET & SETTINGS ─── */}
        <ConfigCollapsible title="Dataset & Settings" icon={<FileText className="h-5 w-5 text-muted-foreground" />} defaultOpen={false}>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Evaluation Mode</Label>
              <Select value={value.evalg_mode} onValueChange={(v) => update({ evalg_mode: v as EvalMode })}>
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
              <PathInputWithUpload
                label="Eval Dataset Path"
                value={value.eval_dataset_path ?? ''}
                onChange={(v) => update({ eval_dataset_path: v })}
                placeholder="output/prepared.jsonl"
                help="JSONL with messages — type a path or upload"
              />
              <LabelInput
                label="Output Report Path"
                value={value.output_report_path ?? ''}
                onChange={(v) => update({ output_report_path: v })}
                placeholder="output/eval_report.json"
              />
            </div>
            <LabelInput
              label="Max Eval Samples"
              type="number"
              value={value.max_eval_samples != null ? String(value.max_eval_samples) : ''}
              onChange={(v) => update({ max_eval_samples: v ? parseInt(v, 10) || undefined : undefined })}
              placeholder="All samples"
              help="Limit the number of samples to evaluate"
            />
          </div>
        </ConfigCollapsible>
      </CardContent>
    </Card>
  )
}

/** Reusable LLM provider / model / key / base-url field group. */
function LLMProviderFields({
  provider,
  model,
  apiKey,
  baseUrl,
  onProviderChange,
  onModelChange,
  onApiKeyChange,
  onBaseUrlChange,
  modelPlaceholder = 'gpt-4',
  allowNone = false,
}: {
  provider?: string
  model?: string
  apiKey?: string
  baseUrl?: string
  onProviderChange: (v: string) => void
  onModelChange: (v: string) => void
  onApiKeyChange: (v: string) => void
  onBaseUrlChange: (v: string) => void
  modelPlaceholder?: string
  allowNone?: boolean
}) {
  const isLocal = provider === 'vllm' || provider === 'ollama' || provider === 'openai_compatible'
  return (
    <div className="space-y-3">
      <div className="space-y-2">
        <Label>Provider</Label>
        <Select value={provider ?? (allowNone ? '' : 'openai')} onValueChange={onProviderChange}>
          <SelectTrigger>
            <SelectValue placeholder={allowNone ? 'None (skip)' : 'Select provider'} />
          </SelectTrigger>
          <SelectContent>
            {allowNone && <SelectItem value="none">None (skip)</SelectItem>}
            {LLM_PROVIDERS.map((p) => (
              <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {provider && provider !== 'none' && (
        <>
          <LabelInput label="Model" value={model ?? ''} onChange={onModelChange} placeholder={modelPlaceholder} />
          <LabelInput label="API Key" type="password" value={apiKey ?? ''} onChange={onApiKeyChange} placeholder="sk-..." help={isLocal ? 'Optional for local providers' : undefined} />
          <LabelInput label="Base URL" value={baseUrl ?? ''} onChange={onBaseUrlChange} placeholder={provider === 'openai_compatible' ? 'https://openrouter.ai/api/v1' : isLocal ? (provider === 'ollama' ? 'http://localhost:11434' : 'http://localhost:8000') : ''} help="Custom API endpoint (e.g. OpenRouter, local vLLM server)" />
        </>
      )}
    </div>
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

function PathInputWithUpload({
  label,
  value,
  onChange,
  placeholder,
  help,
  accept = '.jsonl,.json,.csv',
}: {
  label: string
  value: string
  onChange: (v: string) => void
  placeholder?: string
  help?: string
  accept?: string
}) {
  const fileRef = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(false)

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setUploading(true)
    try {
      const result = await uploadFile(file)
      onChange(result.path)
    } catch (err) {
      console.error('Upload failed:', err)
    } finally {
      setUploading(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      <div className="flex gap-2">
        <Input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className="flex-1"
        />
        <Button
          type="button"
          variant="outline"
          size="icon"
          disabled={uploading}
          onClick={() => fileRef.current?.click()}
          title="Upload file"
        >
          <Upload className="h-4 w-4" />
        </Button>
        <input
          ref={fileRef}
          type="file"
          accept={accept}
          className="hidden"
          onChange={handleUpload}
        />
      </div>
      {help && <p className="text-xs text-muted-foreground">{help}</p>}
    </div>
  )
}
