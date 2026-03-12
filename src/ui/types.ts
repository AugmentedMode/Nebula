export interface ToolData {
  callId: string;
  name: string;
  args: Record<string, unknown>;
  result?: string;
  isError?: boolean;
}

export interface Message {
  id: number;
  role: "user" | "assistant" | "tool" | "error" | "system";
  content: string;
  tool?: ToolData;
}

export interface TaskInfo {
  id: string;
  name: string;
  status: "queued" | "syncing" | "running" | "completed" | "failed" | "cancelled";
  machineId: string;
  pid?: number;
  startedAt: number;
  details?: string;
}
