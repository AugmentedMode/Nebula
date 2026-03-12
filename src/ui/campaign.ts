import type { BackgroundProcess, RemoteMachine } from "../remote/types.js";
import type { MetricStore } from "../metrics/store.js";
import type { MachineResources } from "../metrics/resources.js";
import type { RunRecord } from "../runs/store.js";
import { formatMetricValue, truncate } from "./format.js";
import type { Message, TaskInfo } from "./types.js";

export interface CampaignMetricSummary {
  metric: string;
  value: number;
  direction: "up" | "down";
  taskId: string;
  command: string;
}

export interface CampaignSummary {
  objective: string;
  activeRuns: number;
  queuedRuns: number;
  failedRuns: number;
  completedRuns: number;
  bestMetric: CampaignMetricSummary | null;
  leadingGroup: string | null;
  attention: string;
  liveMetrics: Array<{ name: string; latest: number | null; trend: "up" | "down" | "flat" }>;
}

export interface ExperimentGroup {
  key: string;
  label: string;
  strategy: string;
  verdict: "frontier" | "active" | "staged" | "blocked" | "settled";
  totalRuns: number;
  activeRuns: number;
  queuedRuns: number;
  failedRuns: number;
  latestStartedAt: number;
  machines: string[];
  bestMetric: CampaignMetricSummary | null;
}

export interface FleetMachineSummary {
  machineId: string;
  slotsUsed: number;
  slotsTotal: number;
  queuedRuns: number;
  activeRuns: number;
  roles: string[];
  summary: string;
}

export interface FleetSummary {
  slotsUsed: number;
  slotsTotal: number;
  queuedRuns: number;
  strategyMix: Array<{ label: string; count: number }>;
  machines: FleetMachineSummary[];
}

export interface NarrativeItem {
  icon: string;
  title: string;
  detail: string;
  tone: "neutral" | "good" | "warn";
}

interface TaskEntry {
  id: string;
  command: string;
  status: TaskInfo["status"];
  machineId: string;
  startedAt: number;
}

export function buildTaskEntries(
  tasks: TaskInfo[],
  runs: RunRecord[],
  backgroundProcesses: BackgroundProcess[],
): TaskEntry[] {
  const entries = new Map<string, TaskEntry>();

  for (const run of runs) {
    entries.set(run.id, {
      id: run.id,
      command: run.command,
      status: mapRunStatus(run.status),
      machineId: run.machineId ?? "auto",
      startedAt: run.startedAt ?? run.createdAt,
    });
  }

  for (const proc of backgroundProcesses) {
    const id = proc.runId ?? `${proc.machineId}:${proc.pid}`;
    const existing = entries.get(id);
    const matchedTask = tasks.find((task) => task.id === id);
    entries.set(id, {
      id,
      command: existing?.command ?? proc.command,
      status: matchedTask?.status ?? existing?.status ?? "running",
      machineId: proc.machineId,
      startedAt: existing?.startedAt ?? proc.startedAt,
    });
  }

  for (const task of tasks) {
    if (entries.has(task.id)) continue;
    entries.set(task.id, {
      id: task.id,
      command: task.name,
      status: task.status,
      machineId: task.machineId,
      startedAt: task.startedAt,
    });
  }

  return Array.from(entries.values()).sort((a, b) => b.startedAt - a.startedAt);
}

export function buildCampaignSummary(
  messages: Message[],
  metricData: Map<string, number[]>,
  taskEntries: TaskEntry[],
  metricStore: MetricStore,
): CampaignSummary {
  const objective = getObjective(messages);
  const activeRuns = taskEntries.filter((task) => task.status === "running" || task.status === "syncing").length;
  const queuedRuns = taskEntries.filter((task) => task.status === "queued").length;
  const failedRuns = taskEntries.filter((task) => task.status === "failed").length;
  const completedRuns = taskEntries.filter((task) => task.status === "completed").length;
  const bestMetric = findBestMetric(taskEntries, metricStore);
  const groups = buildExperimentGroups(taskEntries, metricStore);

  return {
    objective,
    activeRuns,
    queuedRuns,
    failedRuns,
    completedRuns,
    bestMetric,
    leadingGroup: groups[0]?.label ?? null,
    attention: buildAttentionLine(activeRuns, queuedRuns, failedRuns),
    liveMetrics: buildLiveMetrics(metricData),
  };
}

export function buildExperimentGroups(
  taskEntries: TaskEntry[],
  metricStore: MetricStore,
): ExperimentGroup[] {
  const grouped = new Map<string, ExperimentGroup>();
  const globalBest = findBestMetric(taskEntries, metricStore);

  for (const task of taskEntries) {
    const key = groupKey(task.command);
    const existing = grouped.get(key);
    const label = groupLabel(task.command);
    const strategy = classifyStrategy(task.command);
    const metric = findTaskMetric(task.id, task.command, metricStore);

    if (!existing) {
      grouped.set(key, {
        key,
        label,
        strategy,
        verdict: "settled",
        totalRuns: 1,
        activeRuns: task.status === "running" || task.status === "syncing" ? 1 : 0,
        queuedRuns: task.status === "queued" ? 1 : 0,
        failedRuns: task.status === "failed" ? 1 : 0,
        latestStartedAt: task.startedAt,
        machines: task.machineId === "auto" ? [] : [task.machineId],
        bestMetric: metric,
      });
      continue;
    }

    existing.totalRuns += 1;
    existing.activeRuns += task.status === "running" || task.status === "syncing" ? 1 : 0;
    existing.queuedRuns += task.status === "queued" ? 1 : 0;
    existing.failedRuns += task.status === "failed" ? 1 : 0;
    existing.latestStartedAt = Math.max(existing.latestStartedAt, task.startedAt);
    if (task.machineId !== "auto" && !existing.machines.includes(task.machineId)) {
      existing.machines.push(task.machineId);
    }
    if (metric && metricBeats(metric, existing.bestMetric)) {
      existing.bestMetric = metric;
    }
  }

  const groups = Array.from(grouped.values());
  for (const group of groups) {
    group.verdict = classifyVerdict(group, globalBest);
  }

  return groups.sort((a, b) => {
    const verdictRank = verdictWeight(a.verdict) - verdictWeight(b.verdict);
    if (verdictRank !== 0) return verdictRank;
    if (a.bestMetric && b.bestMetric && a.bestMetric.metric === b.bestMetric.metric) {
      if (isLowerBetter(a.bestMetric.metric)) {
        return a.bestMetric.value - b.bestMetric.value;
      }
      return b.bestMetric.value - a.bestMetric.value;
    }
    return b.latestStartedAt - a.latestStartedAt;
  });
}

export function buildFleetSummary(
  machines: RemoteMachine[],
  resources: Map<string, MachineResources>,
  taskEntries: TaskEntry[],
): FleetSummary {
  const strategyCounts = new Map<string, number>();
  const machineSummaries: FleetMachineSummary[] = [];
  let slotsUsed = 0;
  let slotsTotal = 0;
  let queuedRuns = 0;

  for (const task of taskEntries) {
    if (task.status === "queued") {
      queuedRuns += 1;
      continue;
    }
    if (task.status !== "running" && task.status !== "syncing") continue;
    const label = classifyStrategy(task.command);
    strategyCounts.set(label, (strategyCounts.get(label) ?? 0) + 1);
  }

  for (const machine of machines) {
    const active = taskEntries.filter((task) =>
      task.machineId === machine.id && (task.status === "running" || task.status === "syncing")
    ).length;
    const queued = taskEntries.filter((task) => task.machineId === machine.id && task.status === "queued").length;
    const total = machine.maxConcurrentTasks ?? 1;
    const resource = resources.get(machine.id);
    slotsUsed += active;
    slotsTotal += total;
    machineSummaries.push({
      machineId: machine.id,
      slotsUsed: active,
      slotsTotal: total,
      queuedRuns: queued,
      activeRuns: active,
      roles: machine.roles ?? [],
      summary: buildMachineSummary(resource),
    });
  }

  return {
    slotsUsed,
    slotsTotal,
    queuedRuns,
    strategyMix: Array.from(strategyCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([label, count]) => ({ label, count })),
    machines: machineSummaries.sort((a, b) => a.machineId.localeCompare(b.machineId)),
  };
}

export function buildNarrative(messages: Message[]): NarrativeItem[] {
  const items: NarrativeItem[] = [];

  for (const message of messages) {
    if (message.role === "user") {
      items.push({
        icon: items.length === 0 ? "O" : ">",
        title: items.length === 0 ? "Objective set" : "Research steer",
        detail: truncate(message.content, 120, true),
        tone: "neutral",
      });
      continue;
    }

    if (message.role === "assistant" && message.content.trim()) {
      items.push({
        icon: "*",
        title: "Agent note",
        detail: truncate(firstLine(message.content), 120, true),
        tone: "neutral",
      });
      continue;
    }

    if (message.role === "tool" && message.tool) {
      const item = narrativeFromTool(message.tool.name, message.tool.args, message.tool.result);
      if (item) items.push(item);
      continue;
    }

    if (message.role === "error") {
      items.push({
        icon: "!",
        title: "Execution error",
        detail: truncate(message.content, 120, true),
        tone: "warn",
      });
      continue;
    }

    if (message.role === "system" && message.content.trim()) {
      items.push({
        icon: ".",
        title: "System",
        detail: truncate(message.content, 120, true),
        tone: "neutral",
      });
    }
  }

  return items.slice(-10).reverse();
}

function getObjective(messages: Message[]): string {
  const latestUser = [...messages].reverse().find((message) =>
    message.role === "user" && !message.content.trim().startsWith("/")
  );
  return latestUser?.content ?? "Set a research objective to start a campaign.";
}

function buildAttentionLine(active: number, queued: number, failed: number): string {
  if (failed > 0) return `${failed} failed run${failed === 1 ? "" : "s"} need triage before promoting results.`;
  if (queued > active && queued > 0) return `${queued} runs are staged behind ${active} active slot${active === 1 ? "" : "s"}.`;
  if (active === 0 && queued === 0) return "No active search yet. Start a campaign or launch a sweep.";
  return "Search is active. Use overlays for raw metrics and task logs.";
}

function buildLiveMetrics(metricData: Map<string, number[]>): Array<{ name: string; latest: number | null; trend: "up" | "down" | "flat" }> {
  return Array.from(metricData.entries())
    .slice(0, 4)
    .map(([name, values]) => ({
      name,
      latest: values.length > 0 ? values[values.length - 1] : null,
      trend: metricTrend(values),
    }));
}

function metricTrend(values: number[]): "up" | "down" | "flat" {
  if (values.length < 2) return "flat";
  const delta = values[values.length - 1] - values[Math.max(0, values.length - 4)];
  if (Math.abs(delta) < 1e-9) return "flat";
  return delta > 0 ? "up" : "down";
}

function classifyVerdict(group: ExperimentGroup, globalBest: CampaignMetricSummary | null): ExperimentGroup["verdict"] {
  if (group.failedRuns === group.totalRuns) return "blocked";
  if (group.activeRuns > 0) {
    if (group.bestMetric && globalBest && group.bestMetric.metric === globalBest.metric && Math.abs(group.bestMetric.value - globalBest.value) < 1e-9) {
      return "frontier";
    }
    return "active";
  }
  if (group.queuedRuns > 0) return "staged";
  if (group.bestMetric && globalBest && group.bestMetric.metric === globalBest.metric) {
    const delta = Math.abs(group.bestMetric.value - globalBest.value);
    if (delta < 1e-9) return "frontier";
  }
  return "settled";
}

function verdictWeight(verdict: ExperimentGroup["verdict"]): number {
  switch (verdict) {
    case "frontier":
      return 0;
    case "active":
      return 1;
    case "staged":
      return 2;
    case "blocked":
      return 4;
    case "settled":
    default:
      return 3;
  }
}

function buildMachineSummary(resource: MachineResources | undefined): string {
  if (!resource) return "telemetry pending";

  const gpuBusy = resource.gpus.filter((gpu) => (gpu.utilization ?? 0) > 50).length;
  const gpuTotal = resource.gpus.length;
  const cpu = resource.cpuPercent !== null ? `${Math.round(resource.cpuPercent)}% CPU` : "CPU n/a";

  if (gpuTotal > 0) {
    return `${gpuBusy}/${gpuTotal} GPUs busy, ${cpu}`;
  }
  return cpu;
}

function narrativeFromTool(
  toolName: string,
  args: Record<string, unknown>,
  result?: string,
): NarrativeItem | null {
  const parsed = parseResult(result);

  switch (toolName) {
    case "sweep":
      return {
        icon: "+",
        title: "Sweep queued",
        detail: `${parsed?.total_combinations ?? "?"} combinations staged from ${truncate(String(args.command_template ?? ""), 72, true)}`,
        tone: "good",
      };
    case "remote_exec_background":
      return {
        icon: "&",
        title: "Run launched",
        detail: `${args.machine_id ?? "?"} -> ${truncate(String(args.command ?? ""), 96, true)}`,
        tone: "good",
      };
    case "compare_runs":
      return {
        icon: "=",
        title: "Runs compared",
        detail: `${args.task_a ?? "?"} vs ${args.task_b ?? "?"}`,
        tone: "neutral",
      };
    case "show_metrics":
      return {
        icon: "~",
        title: "Metrics reviewed",
        detail: truncate(String((args.metric_names as string[] | undefined)?.join(", ") ?? "all metrics"), 96, true),
        tone: "neutral",
      };
    case "start_monitor":
      return {
        icon: "@",
        title: "Monitor armed",
        detail: `${args.interval_minutes ?? "?"}m cadence for ${truncate(String(args.goal ?? ""), 80, true)}`,
        tone: "neutral",
      };
    case "list_machines":
      return {
        icon: "#",
        title: "Fleet checked",
        detail: `${Array.isArray(parsed?.machines) ? parsed?.machines.length : "?"} machines visible`,
        tone: "neutral",
      };
    default:
      return null;
  }
}

function parseResult(result?: string): Record<string, unknown> | null {
  if (!result) return null;
  try {
    return JSON.parse(result) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function firstLine(text: string): string {
  return text.trim().split("\n")[0] ?? "";
}

function groupKey(command: string): string {
  return command
    .split(/\s+/)
    .map((token) => {
      if (/^-/.test(token)) return token;
      if (/^[\d.]+(?:e[+-]?\d+)?$/i.test(token)) return "<num>";
      if (/^['"]?[\w./-]+\.py['"]?$/.test(token)) return token.replace(/^['"]|['"]$/g, "");
      if (/=/.test(token)) {
        const [key] = token.split("=");
        return `${key}=<v>`;
      }
      return token;
    })
    .slice(0, 8)
    .join(" ");
}

function groupLabel(command: string): string {
  const tokens = command.split(/\s+/).filter(Boolean);
  const trainIdx = tokens.findIndex((token) => /train|finetune|eval|benchmark/i.test(token));
  if (trainIdx >= 0) {
    return truncate(tokens.slice(trainIdx, trainIdx + 4).join(" "), 48, true);
  }
  return truncate(tokens.slice(0, 5).join(" "), 48, true);
}

function classifyStrategy(command: string): string {
  const text = command.toLowerCase();
  if (text.includes("baseline")) return "baseline";
  if (text.includes("eval") || text.includes("benchmark")) return "evaluation";
  if (text.includes("ablat")) return "ablation";
  if (text.includes("--lr") || text.includes("--batch") || text.includes("--bs") || text.includes("{")) return "frontier";
  return "exploration";
}

function findBestMetric(taskEntries: TaskEntry[], metricStore: MetricStore): CampaignMetricSummary | null {
  let best: CampaignMetricSummary | null = null;
  for (const task of taskEntries) {
    const metric = findTaskMetric(task.id, task.command, metricStore);
    if (metricBeats(metric, best)) {
      best = metric;
    }
  }
  return best;
}

function metricBeats(
  candidate: CampaignMetricSummary | null,
  current: CampaignMetricSummary | null,
): boolean {
  if (!candidate) return false;
  if (!current) return true;
  if (candidate.metric !== current.metric) {
    return preferredMetricRank(candidate.metric) < preferredMetricRank(current.metric);
  }
  if (isLowerBetter(candidate.metric)) {
    return candidate.value < current.value;
  }
  return candidate.value > current.value;
}

function preferredMetricRank(metric: string): number {
  const normalized = metric.toLowerCase();
  if (normalized.includes("loss")) return 0;
  if (normalized.includes("perplex")) return 1;
  if (normalized.includes("acc")) return 2;
  if (normalized.includes("reward")) return 3;
  if (normalized.includes("score")) return 4;
  return 10;
}

function findTaskMetric(
  taskId: string,
  command: string,
  metricStore: MetricStore,
): CampaignMetricSummary | null {
  const summary = metricStore.getTaskSummary(taskId);
  const metricName = Object.keys(summary).sort((a, b) => preferredMetricRank(a) - preferredMetricRank(b))[0];
  if (!metricName) return null;
  return {
    metric: metricName,
    value: summary[metricName].latest,
    direction: isLowerBetter(metricName) ? "down" : "up",
    taskId,
    command,
  };
}

function isLowerBetter(metric: string): boolean {
  return /loss|perplex|error|wer|latency|time/i.test(metric);
}

function mapRunStatus(status: RunRecord["status"]): TaskInfo["status"] {
  switch (status) {
    case "succeeded":
      return "completed";
    case "queued":
    case "syncing":
    case "running":
    case "failed":
    case "cancelled":
      return status;
    default:
      return "queued";
  }
}

export function formatMetricSummary(metric: CampaignMetricSummary | null): string {
  if (!metric) return "no metrics yet";
  const arrow = metric.direction === "down" ? "lower is better" : "higher is better";
  return `${metric.metric} ${formatMetricValue(metric.value)} (${arrow})`;
}
