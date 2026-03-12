export interface RemoteMachine {
  id: string;
  host: string;
  port: number;
  username: string;
  authMethod: "key" | "agent" | "password";
  keyPath?: string;
  password?: string;
  labels?: string[];
  roles?: Array<"general" | "train">;
  maxConcurrentTasks?: number;
  workspaceRoot?: string;
  syncMode?: "managed";
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface BackgroundProcess {
  runId?: string;
  pid: number;
  machineId: string;
  command: string;
  logPath?: string;
  startedAt: number;
  /** Metric names to auto-parse from stdout (key=value format) */
  metricNames?: string[];
  /** Custom regex patterns: metric name → regex with one capture group */
  metricPatterns?: Record<string, string>;
}

export interface ConnectionStatus {
  machineId: string;
  connected: boolean;
  lastConnectedAt?: number;
  error?: string;
}
