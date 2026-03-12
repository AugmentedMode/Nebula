import type { ToolDefinition } from "../providers/types.js";
import type { ConnectionPool } from "../remote/connection-pool.js";

export function createListMachinesTool(
  pool: ConnectionPool,
): ToolDefinition {
  return {
    name: "list_machines",
    description:
      "List all configured remote machines and their connection status.",
    parameters: {
      type: "object",
      properties: {},
    },
    execute: async () => {
      const statuses = pool.getAllStatuses();
      const machines = pool.getMachineDefinitions();
      return JSON.stringify({
        machines: machines.map((machine) => {
          const status = statuses.find((entry) => entry.machineId === machine.id);
          return {
            id: machine.id,
            connected: status?.connected ?? false,
            last_connected: status?.lastConnectedAt
              ? new Date(status.lastConnectedAt).toISOString()
              : null,
            error: status?.error ?? null,
            roles: machine.roles ?? [],
            max_concurrent_tasks: machine.maxConcurrentTasks ?? 1,
            workspace_root: machine.workspaceRoot ?? null,
          };
        }),
      });
    },
  };
}
