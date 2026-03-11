export type StageId = 'graph_traverser' | 'chatml_converter' | 'finetuner' | 'evaluator'

export interface TraversalConfig {
  strategy: string
  max_nodes: number
  max_depth: number
  reasoning_depth?: number
  max_paths_per_node?: number
  relationship_types?: string
  node_labels?: string
  seed_node_ids?: string
}

export interface DatasetConfig {
  seed_prompts: string[]
  system_message?: string
  include_metadata: boolean
  output_path?: string
}

export interface Neo4jConfig {
  uri: string
  database: string
  username: string
  password: string
}

export interface RedisConfig {
  host: string
  port: number | string
  db: number | string
  password?: string
  key_prefix?: string
}

export interface LLMConfig {
  provider: string
  api_key?: string
  model?: string
  base_url?: string
  project_id?: string
  location?: string
  credentials_path?: string
}

export interface GraphTraverserConfig {
  output_path?: string
  traversal: TraversalConfig
  dataset: DatasetConfig
  neo4j?: Neo4jConfig
  redis?: RedisConfig
  llm?: LLMConfig
  llm_provider?: string
}

export interface ChatMLConverterConfig {
  input_path: string
  output_path: string
  prepare_for_finetuning: boolean
  chat_template?: string
}

export interface FineTunerConfig {
  model_name: string
  model_type: string
  train_data_path: string
  eval_data_path?: string
  output_dir: string
  max_seq_length?: number
  num_train_epochs?: number
  per_device_train_batch_size?: number
  learning_rate?: number
}

export interface EvaluatorConfig {
  model_path?: string
  eval_dataset_path?: string
  output_report_path?: string
  metrics: string[]
  evalg_mode: string
  base_model_provider?: string
  base_model_name?: string
  base_model_api_key?: string
  base_model_base_url?: string
  graph_rag_enabled: boolean
  graph_rag_config?: {
    neo4j_uri?: string
    neo4j_user?: string
    neo4j_password?: string
    neo4j_database?: string
    llm_api_key?: string
    llm_model?: string
    embedding_api_key?: string
    embedding_model?: string
    retrievers?: string[]
    num_agents?: number
    similarity_top_k?: number
  }
  judge_provider?: string
  judge_model?: string
  judge_api_key?: string
  max_eval_samples?: number
}

export interface PipelineConfigPayload {
  output_dir?: string
  run_stages: StageId[]
  graph_traverser?: GraphTraverserConfig
  chatml_converter?: ChatMLConverterConfig
  finetuner?: FineTunerConfig
  evaluator?: EvaluatorConfig
}

export const STAGE_ORDER: StageId[] = ['graph_traverser', 'chatml_converter', 'finetuner', 'evaluator']

export const STAGE_LABELS: Record<StageId, string> = {
  graph_traverser: 'Graph Traverser',
  chatml_converter: 'ChatML Converter',
  finetuner: 'FineTuner',
  evaluator: 'Evaluator',
}
