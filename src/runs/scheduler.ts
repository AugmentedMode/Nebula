import { basename } from "node:path";
import type { FileSync } from "../remote/file-sync.js";
import type { ConnectionPool } from "../remote/connection-pool.js";
import type { RemoteExecutor } from "../remote/executor.js";
import type { RemoteMachine } from "../remote/types.js";
import type { MetricCollector } from "../metrics/collector.js";
import { patternsFromNames, patternsFromRegexes } from "../metrics/parser.js";
import { RunStore, type RunRecord } from "./store.js";

interface RunSchedulerOptions {
  runStore: RunStore;
  executor: RemoteExecutor;
  connectionPool: ConnectionPool;
  fileSync: FileSync;
  metricCollector: MetricCollector;
  workspaceSource: string;
}

export class RunScheduler {
  private runStore: RunStore;
  private executor: RemoteExecutor;
  private connectionPool: ConnectionPool;
  private fileSync: FileSync;
  private metricCollector: MetricCollector;
  private workspaceSource: string;
  private inFlightRuns = new Set<string>();

  constructor(options: RunSchedulerOptions) {
    this.runStore = options.runStore;
    this.executor = options.executor;
    this.connectionPool = options.connectionPool;
    this.fileSync = options.fileSync;
    this.metricCollector = options.metricCollector;
    this.workspaceSource = options.workspaceSource;
  }

  async tick(): Promise<void> {
    const queued = this.runStore.listQueuedRuns();
    for (const run of queued) {
      if (this.inFlightRuns.has(run.id)) continue;
      const machine = this.chooseMachine(run);
      if (!machine) continue;
      this.inFlightRuns.add(run.id);
      void this.launch(run, machine).finally(() => {
        this.inFlightRuns.delete(run.id);
      });
    }
  }

  listRuns(limit = 100): RunRecord[] {
    return this.runStore.listRuns(limit);
  }

  getFleetSummary(): {
    queued: number;
    running: number;
    syncing: number;
    succeeded: number;
    failed: number;
    cancelled: number;
  } {
    const runs = this.runStore.listRuns(500);
    return runs.reduce(
      (acc, run) => {
        acc[run.status] += 1;
        return acc;
      },
      { queued: 0, running: 0, syncing: 0, succeeded: 0, failed: 0, cancelled: 0 } as any,
    );
  }

  cancelRun(id: string): RunRecord | null {
    const run = this.runStore.getRun(id);
    if (!run) return null;
    if (run.status === "queued") {
      this.runStore.markFinished(id, "cancelled", null, "Cancelled by user");
      return this.runStore.getRun(id);
    }
    return run;
  }

  retryRun(id: string): RunRecord | null {
    const run = this.runStore.getRun(id);
    if (!run) return null;
    this.runStore.requeue(id);
    return this.runStore.getRun(id);
  }

  private chooseMachine(run: RunRecord): RemoteMachine | null {
    const candidates = this.connectionPool
      .getMachineDefinitions()
      .filter((machine) => {
        const status = this.connectionPool.getStatus(machine.id);
        if (!status.connected) return false;
        if (run.machineId && run.machineId !== machine.id) return false;
        const maxConcurrentTasks = machine.maxConcurrentTasks ?? (machine.id === "local" ? 1 : 1);
        return this.runStore.countActiveByMachine(machine.id) < maxConcurrentTasks;
      });

    if (candidates.length === 0) return null;

    candidates.sort((a, b) => rankMachine(a) - rankMachine(b));
    return candidates[0] ?? null;
  }

  private async launch(run: RunRecord, machine: RemoteMachine): Promise<void> {
    try {
      this.runStore.markSyncing(run.id, machine.id);
      if (machine.id !== "local") {
        const targetRoot = machine.workspaceRoot ?? `~/nebula-workspaces/${basename(this.workspaceSource)}`;
        await this.executor.exec(machine.id, `mkdir -p ${targetRoot}`);
        await this.fileSync.upload(machine.id, `${this.workspaceSource}/`, `${targetRoot}/`);
      }

      const command = this.wrapCommandForWorkspace(run.command, machine);
      const proc = await this.executor.execBackground(
        machine.id,
        command,
        undefined,
        {
          metricNames: run.metricNames,
          metricPatterns: run.metricPatterns,
          runId: run.id,
        },
      );
      this.runStore.markRunning(run.id, machine.id, proc.pid, proc.logPath);

      if (proc.logPath) {
        const patterns = Object.keys(run.metricPatterns).length > 0
          ? patternsFromRegexes(run.metricPatterns)
          : run.metricNames.length > 0
            ? patternsFromNames(run.metricNames)
            : undefined;
        if (patterns) {
          this.metricCollector.addSource({
            taskId: run.id,
            machineId: machine.id,
            logPath: proc.logPath,
            patterns,
          });
        }
      }
    } catch (err) {
      this.runStore.markFinished(
        run.id,
        "failed",
        null,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  private wrapCommandForWorkspace(command: string, machine: RemoteMachine): string {
    const workspaceRoot = machine.id === "local"
      ? this.workspaceSource
      : (machine.workspaceRoot ?? `~/nebula-workspaces/${basename(this.workspaceSource)}`);
    return `cd ${workspaceRoot} && ${command}`;
  }
}

function rankMachine(machine: RemoteMachine): number {
  const roles = machine.roles ?? [];
  if (roles.includes("train")) return 0;
  if (roles.includes("general")) return 1;
  if (machine.id === "local") return 2;
  return 3;
}
