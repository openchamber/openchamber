export interface DiagnosticEvent {
  at: number;
  source: string;
  action: string;
  detail?: string;
}

export interface DiagnosticCoverage {
  source: string;
  status: 'truncated' | 'read' | 'filtered' | 'empty' | 'nonregular' | 'older files omitted' | 'missing' | 'unreadable' | 'unavailable';
  omitted?: number;
  filtered?: number;
  warnings?: number;
  errors?: number;
}

export interface DiagnosticSnapshot {
  events: DiagnosticEvent[];
  coverage: DiagnosticCoverage[];
}

export interface JournalOptions {
  now?: () => number;
  maxEvents?: number;
  maxAgeMs?: number;
}

export interface LifecycleDetails {
  attempt?: number;
  failureClass?: string;
}

export interface DiagnosticJournal {
  record: (action: string, details?: LifecycleDetails) => void;
  recordHttpResponse: (method: string | undefined, pathname: string, status: number) => void;
  snapshot: () => DiagnosticSnapshot;
}

export interface SshDiagnosticBuffer {
  lines: string[];
  phase?: string;
  updatedAtMs?: number;
  retryAttempt?: number;
  requiresUserAction?: boolean;
}

export interface SshDiagnosticOptions {
  entries: SshDiagnosticBuffer[];
  omittedSources: number;
}

export interface LocalFileDiagnosticOptions {
  electronLogPath?: string;
  home?: string;
  env?: NodeJS.ProcessEnv;
  webPort?: number;
  journal?: Pick<DiagnosticJournal, 'snapshot'>;
}

export interface ProcessEntry {
  ppid: number;
  rssKb: number;
  command: string;
}

export interface ProcessSummary {
  openCodeMb: number;
  childProcesses: number;
  childMb: number;
}

export interface OpenCodeLoad {
  locations: number | null;
  processes: ProcessSummary | null;
}

export interface OpenCodeProcessInfo {
  pid: number;
}

export interface OpenCodeLoadOptions {
  buildOpenCodeUrl: (route: string, query: string) => string | URL;
  getOpenCodeAuthHeaders: () => HeadersInit;
  platform?: NodeJS.Platform;
  listProcesses?: () => Promise<string>;
  fetchImpl?: typeof fetch;
}
