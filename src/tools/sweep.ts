import type { ToolDefinition } from "../providers/types.js";
import type { RemoteExecutor } from "../remote/executor.js";
import type { ConnectionPool } from "../remote/connection-pool.js";
import type { MetricCollector } from "../metrics/collector.js";
import type { RunStore } from "../runs/store.js";
import {
  type MetricPatterns,
  patternsFromNames,
  patternsFromRegexes,
} from "../metrics/parser.js";
import { formatError, shellQuote } from "../ui/format.js";

/**
 * Compute the cartesian product of a parameter grid.
 * e.g. {lr: [0.001, 0.0001], bs: [32, 64]} → [{lr:0.001,bs:32}, {lr:0.001,bs:64}, ...]
 */
function cartesianProduct(
  params: Record<string, unknown[]>,
): Record<string, unknown>[] {
  const keys = Object.keys(params);
  if (keys.length === 0) return [{}];
  const [first, ...rest] = keys;
  const restProduct = cartesianProduct(
    Object.fromEntries(rest.map((k) => [k, params[k]])),
  );
  return params[first].flatMap((val) =>
    restProduct.map((combo) => ({ [first]: val, ...combo })),
  );
}

/**
 * Replace {param_name} placeholders in a command template with concrete values.
 */
function buildCommand(
  template: string,
  params: Record<string, unknown>,
): string {
  let cmd = template;
  for (const [key, value] of Object.entries(params)) {
    const strVal = String(value);
    // Numeric values are safe to inline; quote anything else
    const safe = /^-?[\d.e+-]+$/.test(strVal) ? strVal : shellQuote(strVal);
    cmd = cmd.replaceAll(`{${key}}`, safe);
  }
  return cmd;
}

export function createSweepTool(
  executor: RemoteExecutor,
  pool: ConnectionPool,
  metricCollector: MetricCollector,
  runStore: RunStore,
): ToolDefinition {
  return {
    name: "sweep",
    description:
      "Launch a hyperparameter sweep. Defines a parameter grid and runs experiments in parallel across available machines. Each combination gets its own background process with metric tracking.",
    parameters: {
      type: "object",
      properties: {
        command_template: {
          type: "string",
          description:
            'Command template with {param_name} placeholders. Example: "python train.py --lr {lr} --batch-size {bs}"',
        },
        params: {
          type: "object",
          additionalProperties: {
            type: "array",
            items: {},
          },
          description:
            'Parameter grid. Keys are param names, values are arrays of values. Example: {"lr": [0.001, 0.0001], "bs": [32, 64]}',
        },
        machines: {
          type: "array",
          items: { type: "string" },
          description:
            "Machine IDs to distribute across. Default: all connected machines.",
        },
        metric_names: {
          type: "array",
          items: { type: "string" },
          description:
            'Metrics to track for each run in key=value format. Example: ["loss", "acc"]',
        },
        metric_patterns: {
          type: "object",
          additionalProperties: { type: "string" },
          description:
            'Custom regex patterns for metric parsing. Example: {"loss": "Loss:\\\\s*([\\\\d.e+-]+)"}',
        },
        max_parallel: {
          type: "number",
          description:
            "Max concurrent runs. Default: number of available machines.",
        },
      },
      required: ["command_template", "params"],
    },
    execute: async (args) => {
      const commandTemplate = args.command_template as string;
      const paramGrid = args.params as Record<string, unknown[]>;
      const requestedMachines = args.machines as string[] | undefined;
      const metricNames = args.metric_names as string[] | undefined;
      const metricPatterns = args.metric_patterns as
        | Record<string, string>
        | undefined;
      const maxParallelArg = args.max_parallel as number | undefined;

      // 1. Generate all parameter combinations
      const combinations = cartesianProduct(paramGrid);
      if (combinations.length === 0) {
        return JSON.stringify({ error: "No parameter combinations generated. Check your params grid." });
      }

      let machineIds: string[];
      if (requestedMachines && requestedMachines.length > 0) {
        machineIds = requestedMachines;
      } else {
        machineIds = pool.getMachineIds().filter((id) => pool.getStatus(id).connected);
      }
      if (machineIds.length === 0) {
        return JSON.stringify({ error: "No connected machines available for sweep." });
      }

      if (metricPatterns) {
        patternsFromRegexes(metricPatterns);
      } else if (metricNames && metricNames.length > 0) {
        patternsFromNames(metricNames);
      }

      const queued: Array<{
        run_id: string;
        requested_machine: string | null;
        params: Record<string, unknown>;
        command: string;
      }> = [];
      const requestedMachine = requestedMachines?.length === 1 ? requestedMachines[0] : null;
      for (const combo of combinations) {
        const command = buildCommand(commandTemplate, combo);
        const run = runStore.createRun({
          command,
          machineId: requestedMachine,
          metricNames,
          metricPatterns,
          workspaceSource: process.cwd(),
          workspaceSnapshot: `${Date.now()}`,
        });
        queued.push({
          run_id: run.id,
          requested_machine: requestedMachine,
          params: combo,
          command,
        });
      }

      return JSON.stringify({
        queued,
        total_combinations: combinations.length,
        machines_used: machineIds,
        max_parallel: maxParallelArg ?? null,
        note: "Runs were queued for the scheduler and will launch as machine slots become available.",
      });
    },
  };
}
