import type { ConnectionPool } from "../remote/connection-pool.js";

interface BatchEntry {
  id: string;
  command: string;
  resolve: (output: string) => void;
  reject: (error: Error) => void;
}

const DELIMITER_PREFIX = "---NEBULA_DELIM:";
const DELIMITER_SUFFIX = "---";

/**
 * Batches SSH commands per host per evaluation cycle.
 * Instead of running N SSH commands for N checks on the same host,
 * builds a single compound command with delimiters and parses results.
 */
export class SSHBatcher {
  private pending = new Map<string, BatchEntry[]>();

  constructor(private pool: ConnectionPool) {}

  /**
   * Enqueue a command to be run on a remote host.
   * Returns a promise that resolves with the command's output.
   */
  enqueue(machineId: string, command: string, id: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const entries = this.pending.get(machineId) ?? [];
      entries.push({ id, command, resolve, reject });
      this.pending.set(machineId, entries);
    });
  }

  /**
   * Flush all pending commands — execute one SSH call per host.
   */
  async flush(): Promise<void> {
    const promises: Promise<void>[] = [];

    for (const [machineId, entries] of this.pending) {
      promises.push(this.executeBatch(machineId, entries));
    }

    this.pending.clear();
    await Promise.allSettled(promises);
  }

  private async executeBatch(
    machineId: string,
    entries: BatchEntry[],
  ): Promise<void> {
    if (entries.length === 0) return;

    // Single command: just run it directly
    if (entries.length === 1) {
      try {
        const result = await this.pool.exec(
          machineId,
          entries[0].command,
        );
        entries[0].resolve(result.stdout);
      } catch (err) {
        entries[0].reject(
          err instanceof Error ? err : new Error(String(err)),
        );
      }
      return;
    }

    // Multiple commands: batch with delimiters
    const batchedCommand = entries
      .map(
        (entry) =>
          `echo "${DELIMITER_PREFIX}${entry.id}${DELIMITER_SUFFIX}"\n${entry.command}`,
      )
      .join("\n");

    try {
      const result = await this.pool.exec(machineId, batchedCommand);
      const outputs = this.parseOutput(result.stdout, entries);

      for (const entry of entries) {
        const output = outputs.get(entry.id);
        if (output !== undefined) {
          entry.resolve(output);
        } else {
          entry.reject(
            new Error(`No output found for command ${entry.id}`),
          );
        }
      }
    } catch (err) {
      const error =
        err instanceof Error ? err : new Error(String(err));
      for (const entry of entries) {
        entry.reject(error);
      }
    }
  }

  private parseOutput(
    stdout: string,
    entries: BatchEntry[],
  ): Map<string, string> {
    const outputs = new Map<string, string>();
    const lines = stdout.split("\n");

    let currentId: string | null = null;
    let currentLines: string[] = [];

    for (const line of lines) {
      const delimMatch = line.match(
        new RegExp(
          `^${DELIMITER_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(.+?)${DELIMITER_SUFFIX}$`,
        ),
      );

      if (delimMatch) {
        if (currentId) {
          outputs.set(currentId, currentLines.join("\n"));
        }
        currentId = delimMatch[1];
        currentLines = [];
      } else {
        currentLines.push(line);
      }
    }

    if (currentId) {
      outputs.set(currentId, currentLines.join("\n"));
    }

    return outputs;
  }
}
