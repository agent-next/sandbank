// --- Adapter configuration ---

export interface InstaBoxAdapterConfig {
  /** InstaBox API key. Default: `INSTABOX_API_KEY` env var. */
  apiKey?: string

  /** API base URL. Default: `INSTABOX_API_URL` env var, else 'https://api.instabox.sh'. */
  apiUrl?: string

  /** Template id used when CreateConfig.image is not set. Default: 'universal'. */
  template?: string
}

// --- Client configuration (resolved, passed to the REST client) ---

export interface InstaBoxClientConfig {
  apiKey: string
  apiUrl?: string
}

// --- API types (https://instabox.sh/docs/api, OpenAPI: /v1/openapi.json) ---

export type InstaBoxMachineState =
  | 'creating'
  | 'starting'
  | 'running'
  | 'stopping'
  | 'stopped'
  | 'suspending'
  | 'suspended'
  | 'resuming'
  | 'deleting'
  | 'deleted'
  | 'error'

export interface InstaBoxMachine {
  id: string
  name: string
  state: InstaBoxMachineState
  createdAt: string
  /** The active operation, if any. */
  operationId?: string | null
  /** The sandbox's source snapshot (also carries template images). */
  snapshot?: { id: string }
  metadata?: Record<string, string>
}

export interface InstaBoxCreateMachineRequest {
  /** 1-63 lowercase letters/digits/'-'. */
  name: string
  /** Exactly one of templateId / snapshotId. */
  templateId?: string
  /** Create from a snapshot (`sn_...`) instead of a template. */
  snapshotId?: string
  /** Lifetime from now in seconds, 60-86400 (>4 h is clamped server-side unless granted). */
  timeoutSeconds?: number
  /** 'kill' deletes at timeout, 'pause' (default) suspends. */
  onTimeout?: 'pause' | 'kill'
  /** String labels; `key:value` filters on list. */
  metadata?: Record<string, string>
  /** False: the machine never receives Vault items. */
  vault?: boolean
}

export interface InstaBoxOperation {
  id: string
  machineId: string
  type: 'create' | 'start' | 'stop' | 'suspend' | 'resume' | 'delete'
  state: 'queued' | 'running' | 'succeeded' | 'failed'
  error: {
    code?: string
    message?: string
    operationId?: string | null
    requestId?: string
    retryable?: boolean
  } | null
  /** The machine as of completion; present on success when still readable. */
  machine?: InstaBoxMachine
}

export interface InstaBoxMachineList {
  machines: InstaBoxMachine[]
  /** Pass as `cursor` for the next page; null on the last page. */
  nextCursor: string | null
}

export interface InstaBoxExecRequest {
  /** Shell command, run with `bash -lc`. Max 64 KiB. */
  cmd: string
  cwd?: string
  /** Environment variables exported before the command. */
  envs?: Record<string, string>
  /** Fed to the command, then EOF. Max 1 MiB. */
  stdin?: string
  /** Default 60, max 600. */
  timeoutSeconds?: number
}

export interface InstaBoxExecResult {
  stdout: string
  stderr: string
  exitCode: number
  timedOut: boolean
  truncated: boolean
}

/** GET /v1/machines/{id}/files response for one path. */
export interface InstaBoxFile {
  path: string
  type: 'dir' | 'file' | 'other'
  size: number
  mode: string
  modTime: string
  /** A text file's content (UTF-8); empty for binary. */
  content?: string
  /** The file is not UTF-8 text; content is empty. */
  binary?: boolean
  /** The file has more bytes than returned. */
  truncated?: boolean
}

export interface InstaBoxPublicPort {
  id: string
  machineId: string
  port: number
  name: string
  url: string
  createdAt: string
}

export interface InstaBoxSnapshot {
  /** `sn_...` */
  id: string
  name: string
  status: 'pending' | 'ready' | 'failed'
  /** Why a `failed` snapshot failed. */
  error?: string
  createdAt: string
}

// --- Unified client interface ---

export interface InstaBoxClient {
  createMachine(body: InstaBoxCreateMachineRequest): Promise<InstaBoxOperation>
  getMachine(id: string): Promise<InstaBoxMachine>
  listMachines(params?: { metadata?: string[]; limit?: number; cursor?: string }): Promise<InstaBoxMachineList>
  deleteMachine(id: string): Promise<InstaBoxOperation>
  machineAction(id: string, action: 'start' | 'stop' | 'suspend' | 'resume'): Promise<InstaBoxOperation>
  /** Long-poll the operation for up to waitSeconds (capped at 30 by the API). */
  getOperation(id: string, waitSeconds?: number): Promise<InstaBoxOperation>
  exec(machineId: string, request: InstaBoxExecRequest): Promise<InstaBoxExecResult>
  readFile(machineId: string, path: string): Promise<InstaBoxFile>
  publishPort(machineId: string, port: number): Promise<InstaBoxPublicPort>
  createSnapshot(machineId: string, name: string): Promise<InstaBoxSnapshot>
  getSnapshot(id: string): Promise<InstaBoxSnapshot>
}
