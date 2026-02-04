import { useState, useCallback } from 'react'
import { Download, Play, Database, FileText, Globe, Check, ChevronDown, Cpu } from 'lucide-react'
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
import type { PipelineConfigPayload, StageId, GraphTraverserConfig, ChatMLConverterConfig, FineTunerConfig, RedisConfig, LLMConfig } from '@/types/config'
import { STAGE_ORDER, STAGE_LABELS } from '@/types/config'
import { runPipeline, runPipelineViaWebSocket } from '@/api/client'
import type { RunResultResponse } from '@/api/client'
import type { WsEvent } from '@/api/client'
import { cn } from '@/lib/utils'

const STAGE_DESCRIPTIONS: Record<StageId, string> = {
  graph_traverser: 'Traverse Neo4j graph and generate conversations',
  chatml_converter: 'Convert and prepare ChatML datasets',
  finetuner: 'Fine-tune models with Unsloth',
  evaluator: 'Evaluate model performance',
}

const STRATEGY_OPTIONS = [
  { value: 'bfs', label: 'Breadth-First Search' },
  { value: 'dfs', label: 'Depth-First Search' },
  { value: 'random', label: 'Random' },
]

const defaultTraversal = {
  strategy: 'bfs',
  max_nodes: 500,
  max_depth: 5,
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
  neo4j: { uri: 'neo4j://localhost:7687', database: 'neo4j', username: 'neo4j', password: '' },
  redis: defaultRedis,
  llm: defaultLLM,
}

const defaultChatML: ChatMLConverterConfig = {
  input_path: 'data/chatml.jsonl',
  output_path: 'data/prepared.jsonl',
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

interface ConfigurePipelineProps {
  onRun: (runId: string, config: PipelineConfigPayload) => void
  onExportConfig?: (config: PipelineConfigPayload) => void
  setWsEvents?: React.Dispatch<React.SetStateAction<WsEvent[]>>
  onDone?: (result: RunResultResponse) => void
}

export default function ConfigurePipeline({ onRun, onExportConfig, setWsEvents, onDone }: ConfigurePipelineProps) {
  const [selectedStages, setSelectedStages] = useState<StageId[]>(['graph_traverser', 'chatml_converter'])
  const [graphTraverser, setGraphTraverser] = useState<GraphTraverserConfig>(defaultGraphTraverser)
  const [chatml, setChatml] = useState<ChatMLConverterConfig>(defaultChatML)
  const [finetuner, setFinetuner] = useState<FineTunerConfig>(defaultFineTuner)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const toggleStage = (id: StageId) => {
    if (id === 'evaluator') return
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
      payload.graph_traverser = {
        ...graphTraverser,
        output_path: graphTraverser.output_path || 'output/dataset.jsonl',
        traversal: graphTraverser.traversal,
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
    return payload
  }, [selectedStages, graphTraverser, chatml, finetuner])

  const handleRun = () => {
    setError(null)
    setRunning(true)
    const config = buildConfig()
    if (setWsEvents && onDone) {
      setWsEvents([])
      runPipelineViaWebSocket(config as unknown as Record<string, unknown>, {
        onRunId: (id) => onRun(id, config),
        onEvent: (e) => setWsEvents((prev) => [...prev, e]),
        onDone: (r) => {
          onDone(r)
          setRunning(false)
        },
        onError: (msg) => {
          setError(msg)
          setRunning(false)
        },
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
    const config = buildConfig()
    const blob = new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = 'pipeline-config.json'
    a.click()
    URL.revokeObjectURL(a.href)
    onExportConfig?.(config)
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
              const disabled = id === 'evaluator'
              return (
                <Button
                  key={id}
                  type="button"
                  variant="outline"
                  disabled={disabled}
                  onClick={() => !disabled && toggleStage(id)}
                  className={cn(
                    'h-auto min-w-0 overflow-hidden flex flex-col items-stretch p-4 text-left',
                    active && 'border-primary bg-primary/10',
                    disabled && 'opacity-70 cursor-not-allowed'
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
                    {active && !disabled && <Check className="h-5 w-5 shrink-0 text-primary" />}
                  </div>
                  <div className="min-w-0 mt-2 flex flex-col gap-0.5">
                    <span className="font-semibold break-words">{STAGE_LABELS[id]}</span>
                    <span className="text-sm text-muted-foreground line-clamp-2 break-words">
                      {STAGE_DESCRIPTIONS[id]}
                    </span>
                    {id === 'evaluator' && (
                      <span className="text-xs text-muted-foreground mt-1">Coming Soon</span>
                    )}
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
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={handleExport}>
              <Download className="h-4 w-4" />
              Export Config
            </Button>
            <Button type="button" onClick={handleRun} disabled={running}>
              <Play className="h-4 w-4" />
              Run Pipeline
            </Button>
          </div>
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
            </div>
            <LabelInput label="Max Nodes" type="number" value={String(value.traversal.max_nodes)} onChange={(v) => updateTraversal({ max_nodes: parseInt(v, 10) || 0 })} />
            <LabelInput label="Max Depth" type="number" value={String(value.traversal.max_depth)} onChange={(v) => updateTraversal({ max_depth: parseInt(v, 10) || 0 })} />
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
          <LabelInput label="Input Path" value={value.input_path} onChange={(v) => onChange({ ...value, input_path: v })} placeholder="data/chatml.jsonl" help="Path to ChatML JSONL file" />
          <LabelInput label="Output Path" value={value.output_path} onChange={(v) => onChange({ ...value, output_path: v })} placeholder="data/prepared.jsonl" help="Path for prepared dataset output" />
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
