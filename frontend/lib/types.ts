export interface AiConnectionConfig {
  id: string;
  name: string;
  base_url: string;
  model: string;
  models: string[];
  api_key_configured: boolean;
  created_at?: number;
}

export interface AiSettings {
  ai_configs: AiConnectionConfig[];
  active_ai_config_id: string;
}

export interface AiConnectionTestResult {
  ok?: boolean;
  message: string;
  config_id?: string;
  config_name?: string;
  models?: string[];
  config?: AiConnectionConfig;
}

export interface AiModelTestResult {
  ok?: boolean;
  message: string;
  config_id?: string;
  config_name?: string;
  response?: string;
}

export interface AiUsageEntry {
  label: string;
  used?: number | null;
  total?: number | null;
  remaining?: number | null;
  used_percent?: number | null;
  resets_at?: number | null;
  unit?: string;
}

export interface AiUsageSummary {
  config_id: string;
  config_name?: string;
  provider?: string;
  supported: boolean;
  kind?: string;
  level?: string;
  entries: AiUsageEntry[];
  message?: string;
}

export interface AiUsageResponse {
  usages: AiUsageSummary[];
}

export interface ServiceSummary {
  id: string;
  name: string;
  description: string;
  path: string;
  icon?: string;
}

export interface FileManagerEntry {
  name: string;
  path: string;
  type: "directory" | "file" | "other";
  size: number;
  modified: number;
  extension: string;
  /** 条目本身是符号链接；目录链接可正常进入与上传 */
  symlink?: boolean;
  download_url?: string;
  relative_path?: string;
}

export interface FileManagerDirectoryResponse {
  root_index: number;
  root_path: string;
  path: string;
  entries: FileManagerEntry[];
  cached: boolean;
  generated_at: number;
  expires_at: number;
  cache_ttl_seconds: number;
  max_entries: number;
  truncated: boolean;
}

export interface FileManagerPlyResponse {
  entries: FileManagerEntry[];
  cached: boolean;
  generated_at: number;
  expires_at: number;
}

export interface MarkdownFileResponse {
  root_index: number;
  path: string;
  entries: FileManagerEntry[];
  cached: boolean;
  generated_at: number;
  expires_at: number;
  truncated: boolean;
}

export interface MarkdownDocument {
  root_index: number;
  path: string;
  name: string;
  content: string;
  size: number;
  modified: number;
}

export interface FileManagerDatePlyEntry extends FileManagerEntry {
  root_index: number;
  source_path: string;
  date_folder: string;
  experiment_date: string;
  iteration_number: number | null;
}

export interface FileManagerDatePlyResponse {
  entries: FileManagerDatePlyEntry[];
  start_date: string;
  end_date: string;
  iteration_mode: "latest" | "exact" | "all";
  iteration: number | null;
  cached: boolean;
}

export interface FileManagerUploadResponse {
  root_index: number;
  directory: string;
  path: string;
  name: string;
  size: number;
  overwrite: boolean;
  modified: number;
}

export interface FileManagerSyncResponse {
  targets: string[];
  directory_count: number;
  synced_at: number;
  cache_ttl_seconds: number;
}

export interface FileManagerFavorite {
  id: string;
  name: string;
  root_path: string;
  path: string;
}

export interface ModelFile {
  name: string;
  path: string;
  size: number;
  modified: number;
}

export interface ModelRepository {
  name: string;
  display_name: string;
  path: string;
  modified: number;
  has_config: boolean;
  has_model_files: boolean;
}

export interface CustomService {
  id: string;
  name: string;
  command: string;
  service_category: "llm" | "asr" | string;
  service_type?: string;
  gpu_indexes?: number[];
  port?: number | null;
  created_at?: number;
}

export interface ManagedProcess {
  pid: number;
  model?: string | null;
  model_name?: string | null;
  display_name?: string | null;
  service_id?: string | null;
  service_category?: string | null;
  service_kind?: string | null;
  service_type?: string | null;
  command?: string | null;
  command_tokens?: string[];
  host?: string | null;
  port?: number | null;
  gpu_indexes?: number[];
  log_file?: string | null;
  started_at?: number | null;
  running?: boolean;
  process_create_time?: number | null;
}

export interface GpuProcess {
  pid: number;
  gpu_pid?: number | null;
  gpu_index?: number | null;
  process_type?: string | null;
  used_mem?: number | null;
  process_name?: string | null;
  username?: string | null;
  command?: string | null;
  model_name?: string | null;
  display_name?: string | null;
  service_id?: string | null;
  managed?: boolean;
}

export interface GpuHistoryPoint {
  timestamp: number;
  gpu_util: number;
  used_mem?: number | null;
  total_mem?: number | null;
}

export interface GpuStatus {
  index: number;
  name?: string | null;
  driver_version?: string | null;
  uuid?: string | null;
  bus_id?: string | null;
  gpu_util?: number | null;
  used_mem?: number | null;
  total_mem?: number | null;
  temperature?: number | null;
  process_count?: number;
  users?: string[];
  history?: GpuHistoryPoint[];
  processes?: GpuProcess[];
}

export interface GpuResponse {
  ok?: boolean;
  error?: string | null;
  history_hours?: number;
  gpus?: GpuStatus[];
  managed_processes?: ManagedProcess[];
  gpu_processes?: GpuProcess[];
}

export interface DownloadTask {
  id: string;
  repo: string;
  filename?: string | null;
  target_dir?: string | null;
  running: boolean;
  done: boolean;
  error?: string | null;
  progress?: number;
  progress_n?: number;
  progress_total?: number;
  created_at?: number;
  updated_at?: number;
  cancel_requested?: boolean;
}

export interface DownloadStatus {
  running: boolean;
  done: boolean;
  repo?: string | null;
  filename?: string | null;
  target_dir?: string | null;
  error?: string | null;
  progress?: number;
  downloads?: DownloadTask[];
}

export interface LlamaSettings {
  model_dir?: string;
  gpu_history_hours?: number;
  [key: string]: unknown;
}

export interface AsrRecord {
  id: string;
  name?: string;
  filename?: string;
  status?: string;
  progress?: number;
  progress_detail?: string;
  error?: string | null;
  created_at?: string;
  updated_at?: string;
  duration?: number;
}

export interface AsrInfo {
  ok: boolean;
  pid: number;
  name: string;
  max_chunk_seconds: number;
}

export interface Connection {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  auth_type: "key" | "password" | "agent" | string;
  private_key_path?: string;
  timezone?: string;
  timezone_auto?: boolean;
  last_test_at?: string | null;
  last_test_ok?: boolean | null;
  last_test_message?: string | null;
  server_time?: string | null;
  server_epoch?: number | null;
  key_installed?: boolean;
  key_installed_at?: string | null;
}

export interface RemoteTime {
  server_time: string;
  timezone: string;
  epoch?: number;
}

export interface RemoteTask {
  id: string;
  name: string;
  connection_id: string;
  connection_name?: string;
  execution_mode: "codex" | "terminal" | string;
  project_dir?: string;
  executor?: string;
  model?: string;
  reasoning_effort?: string;
  prompt_source?: "direct" | "file" | string;
  prompt?: string;
  prompt_file?: string;
  output_file?: string;
  command: string;
  schedule_type: "immediate" | "daily" | "weekly" | "once" | string;
  run_time?: string;
  run_date?: string;
  weekdays?: number[];
  enabled: boolean;
  running?: boolean;
  last_run_at?: string | null;
  last_status?: string;
  last_message?: string;
  last_output?: string;
  last_exit_code?: number | null;
  next_run_at?: string | null;
  timezone?: string;
  log_file?: string;
  log_cwd?: string;
}

export interface PromptGroup {
  id: string;
  name: string;
  created_at?: string;
}

export interface PromptItem {
  id: string;
  content: string;
  raw_content?: string;
  polished_content?: string;
  group_id?: string;
  created_at?: string;
  updated_at?: string;
}

export type PromptPolishLevel = "light" | "standard" | "deep";

export type PromptPolishPrompts = Record<PromptPolishLevel, string>;
export type PromptReasoningEffort = "auto" | "low" | "medium" | "high";

export interface PromptPolishSettings {
  prompts: PromptPolishPrompts;
  defaults: PromptPolishPrompts;
  reasoning_effort: PromptReasoningEffort;
  reasoning_effort_options?: Record<PromptReasoningEffort, string>;
}

export interface PromptPolishResult {
  content: string;
  level: PromptPolishLevel;
  model: string;
  reasoning_effort?: PromptReasoningEffort;
}

export interface ApiErrorShape {
  detail?: string;
  error?: string;
  message?: string;
}
