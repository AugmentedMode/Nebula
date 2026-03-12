import { ConnectionPool } from "./connection-pool.js";
import type { ExecResult, BackgroundProcess } from "./types.js";

/**
 * High-level remote execution interface.
 * Wraps ConnectionPool with task tracking and convenience methods.
 */
export class RemoteExecutor {
  private backgroundProcesses = new Map<string, BackgroundProcess>();
  private commandAvailability = new Map<string, boolean>();

  constructor(private pool: ConnectionPool) {}

  async exec(
    machineId: string,
    command: string,
    timeoutMs?: number,
  ): Promise<ExecResult> {
    if (timeoutMs) {
      const wrappedCmd = `timeout ${Math.ceil(timeoutMs / 1000)} ${command}`;
      return this.pool.exec(machineId, wrappedCmd);
    }
    return this.pool.exec(machineId, command);
  }

  async execBackground(
    machineId: string,
    command: string,
    logPath?: string,
    opts?: { metricNames?: string[]; metricPatterns?: Record<string, string>; runId?: string },
  ): Promise<BackgroundProcess> {
    const normalizedCommand = await this.normalizeBackgroundCommand(machineId, command);
    const result = await this.pool.execBackground(
      machineId,
      normalizedCommand,
      logPath,
    );

    const proc: BackgroundProcess = {
      runId: opts?.runId,
      pid: result.pid,
      machineId,
      command: normalizedCommand,
      logPath: result.logPath,
      startedAt: Date.now(),
      metricNames: opts?.metricNames,
      metricPatterns: opts?.metricPatterns,
    };

    const key = `${machineId}:${result.pid}`;
    this.backgroundProcesses.set(key, proc);
    return proc;
  }

  async isRunning(machineId: string, pid: number): Promise<boolean> {
    return this.pool.isProcessRunning(machineId, pid);
  }

  async tail(
    machineId: string,
    path: string,
    lines = 50,
  ): Promise<string> {
    return this.pool.tailFile(machineId, path, lines);
  }

  async gpuStatus(machineId: string): Promise<string> {
    const result = await this.pool.exec(
      machineId,
      "nvidia-smi --query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu --format=csv,noheader",
    );
    return result.stdout;
  }

  getBackgroundProcesses(): BackgroundProcess[] {
    return Array.from(this.backgroundProcesses.values());
  }

  getBackgroundProcess(
    machineId: string,
    pid: number,
  ): BackgroundProcess | undefined {
    return this.backgroundProcesses.get(`${machineId}:${pid}`);
  }

  removeBackgroundProcess(key: string): void {
    this.backgroundProcesses.delete(key);
  }

  private async normalizeBackgroundCommand(machineId: string, command: string): Promise<string> {
    const split = splitShellPrefix(command);
    const normalizedSegment = await this.normalizePythonSegment(machineId, split.segment);
    return `${split.prefix}${normalizedSegment}`;
  }

  private async normalizePythonSegment(machineId: string, segment: string): Promise<string> {
    if (!looksLikePythonCommand(segment)) return segment;
    if (alreadyWrappedWithUv(segment)) return segment;

    if (await this.hasCommand(machineId, "uv")) {
      return `uv run ${segment}`;
    }

    if (startsWithPython(segment)
      && !(await this.hasCommand(machineId, "python"))
      && (await this.hasCommand(machineId, "python3"))) {
      return replaceLeadingPython(segment, "python3");
    }

    return segment;
  }

  private async hasCommand(machineId: string, commandName: string): Promise<boolean> {
    const key = `${machineId}:${commandName}`;
    const cached = this.commandAvailability.get(key);
    if (cached !== undefined) return cached;

    try {
      const result = await this.pool.exec(
        machineId,
        `command -v ${commandName} >/dev/null 2>&1 && echo yes || echo no`,
      );
      const available = result.stdout.trim() === "yes";
      this.commandAvailability.set(key, available);
      return available;
    } catch {
      this.commandAvailability.set(key, false);
      return false;
    }
  }
}

function looksLikePythonCommand(command: string): boolean {
  const trimmed = command.trim();
  return /^(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)*(python(?:3(?:\.\d+)?)?)(?:\s|$)/.test(trimmed);
}

function startsWithPython(command: string): boolean {
  return /^(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)*python(?:\s|$)/.test(command.trim());
}

function alreadyWrappedWithUv(command: string): boolean {
  return /^(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)*uv\s+run(?:\s|$)/.test(command.trim());
}

function splitShellPrefix(command: string): { prefix: string; segment: string } {
  const idx = command.lastIndexOf("&&");
  if (idx === -1) {
    return { prefix: "", segment: command.trim() };
  }
  return {
    prefix: `${command.slice(0, idx + 2)} `,
    segment: command.slice(idx + 2).trim(),
  };
}

function replaceLeadingPython(command: string, replacement: string): string {
  return command.replace(
    /^((?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)*)python(?=\s|$)/,
    `$1${replacement}`,
  );
}
