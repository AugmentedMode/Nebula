import { nanoid } from "nanoid";
import { getDb } from "../store/database.js";

export type RunStatus =
  | "queued"
  | "syncing"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

export interface RunRecord {
  id: string;
  sessionId: string | null;
  machineId: string | null;
  status: RunStatus;
  command: string;
  logPath: string | null;
  pid: number | null;
  metricNames: string[];
  metricPatterns: Record<string, string>;
  workspaceSource: string | null;
  workspaceTarget: string | null;
  workspaceSnapshot: string | null;
  createdAt: number;
  startedAt: number | null;
  completedAt: number | null;
  error: string | null;
  exitCode: number | null;
}

interface CreateRunInput {
  sessionId?: string | null;
  command: string;
  machineId?: string | null;
  metricNames?: string[];
  metricPatterns?: Record<string, string>;
  workspaceSource?: string | null;
  workspaceTarget?: string | null;
  workspaceSnapshot?: string | null;
}

export class RunStore {
  createRun(input: CreateRunInput): RunRecord {
    const db = getDb();
    const now = Date.now();
    const id = nanoid();
    db.prepare(
      `INSERT INTO queued_runs (
        id, session_id, machine_id, status, command, metric_names, metric_patterns,
        workspace_source, workspace_target, workspace_snapshot, created_at
      ) VALUES (?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      input.sessionId ?? null,
      input.machineId ?? null,
      input.command,
      JSON.stringify(input.metricNames ?? []),
      JSON.stringify(input.metricPatterns ?? {}),
      input.workspaceSource ?? null,
      input.workspaceTarget ?? null,
      input.workspaceSnapshot ?? null,
      now,
    );
    return this.getRun(id)!;
  }

  listRuns(limit = 100): RunRecord[] {
    const db = getDb();
    const rows = db.prepare(
      `SELECT * FROM queued_runs ORDER BY created_at DESC LIMIT ?`
    ).all(limit) as Record<string, unknown>[];
    return rows.map(mapRun);
  }

  getRun(id: string): RunRecord | null {
    const db = getDb();
    const row = db.prepare(`SELECT * FROM queued_runs WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
    return row ? mapRun(row) : null;
  }

  listPendingRuns(): RunRecord[] {
    const db = getDb();
    const rows = db.prepare(
      `SELECT * FROM queued_runs WHERE status IN ('queued', 'syncing', 'running') ORDER BY created_at ASC`
    ).all() as Record<string, unknown>[];
    return rows.map(mapRun);
  }

  listQueuedRuns(): RunRecord[] {
    const db = getDb();
    const rows = db.prepare(
      `SELECT * FROM queued_runs WHERE status = 'queued' ORDER BY created_at ASC`
    ).all() as Record<string, unknown>[];
    return rows.map(mapRun);
  }

  countActiveByMachine(machineId: string): number {
    const db = getDb();
    const row = db.prepare(
      `SELECT COUNT(*) as c FROM queued_runs WHERE machine_id = ? AND status IN ('syncing', 'running')`
    ).get(machineId) as { c: number };
    return row.c;
  }

  markSyncing(id: string, machineId: string): void {
    this.update(id, {
      machine_id: machineId,
      status: "syncing",
      started_at: Date.now(),
      error: null,
    });
  }

  markRunning(id: string, machineId: string, pid: number, logPath?: string): void {
    this.update(id, {
      machine_id: machineId,
      status: "running",
      pid,
      log_path: logPath ?? null,
      started_at: Date.now(),
      error: null,
    });
  }

  markFinished(id: string, status: Extract<RunStatus, "succeeded" | "failed" | "cancelled">, exitCode?: number | null, error?: string | null): void {
    this.update(id, {
      status,
      exit_code: exitCode ?? null,
      error: error ?? null,
      completed_at: Date.now(),
    });
  }

  requeue(id: string): void {
    this.update(id, {
      status: "queued",
      machine_id: null,
      pid: null,
      log_path: null,
      started_at: null,
      completed_at: null,
      exit_code: null,
      error: null,
    });
  }

  resetActiveRunsToQueued(): void {
    const db = getDb();
    db.prepare(
      `UPDATE queued_runs
       SET status = 'queued', pid = NULL, log_path = NULL, started_at = NULL, error = NULL
       WHERE status IN ('syncing', 'running')`
    ).run();
  }

  private update(id: string, values: Record<string, unknown>): void {
    const db = getDb();
    const entries = Object.entries(values);
    const setClause = entries.map(([key]) => `${key} = ?`).join(", ");
    db.prepare(`UPDATE queued_runs SET ${setClause} WHERE id = ?`).run(
      ...entries.map(([, value]) => value),
      id,
    );
  }
}

function mapRun(row: Record<string, unknown>): RunRecord {
  return {
    id: row.id as string,
    sessionId: row.session_id as string | null,
    machineId: row.machine_id as string | null,
    status: row.status as RunStatus,
    command: row.command as string,
    logPath: row.log_path as string | null,
    pid: row.pid as number | null,
    metricNames: JSON.parse((row.metric_names as string | null) ?? "[]") as string[],
    metricPatterns: JSON.parse((row.metric_patterns as string | null) ?? "{}") as Record<string, string>,
    workspaceSource: row.workspace_source as string | null,
    workspaceTarget: row.workspace_target as string | null,
    workspaceSnapshot: row.workspace_snapshot as string | null,
    createdAt: row.created_at as number,
    startedAt: row.started_at as number | null,
    completedAt: row.completed_at as number | null,
    error: row.error as string | null,
    exitCode: row.exit_code as number | null,
  };
}
