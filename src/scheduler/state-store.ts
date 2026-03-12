import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { getNebulaDir } from "../store/database.js";
import type { SleepSession } from "./triggers/types.js";

const TRIGGERS_FILE = "triggers.json";

interface PersistedState {
  version: 1;
  sessions: SerializedSession[];
}

interface SerializedSession {
  session: Omit<SleepSession, "trigger"> & {
    trigger: Omit<SleepSession["trigger"], "satisfiedLeaves"> & {
      satisfiedLeaves: string[];
    };
  };
}

export class TriggerStateStore {
  private filePath: string;

  constructor() {
    this.filePath = join(getNebulaDir(), TRIGGERS_FILE);
  }

  save(sessions: SleepSession[]): void {
    const state: PersistedState = {
      version: 1,
      sessions: sessions.map((s) => ({
        session: {
          ...s,
          trigger: {
            ...s.trigger,
            satisfiedLeaves: Array.from(s.trigger.satisfiedLeaves),
          },
        },
      })),
    };

    const dir = getNebulaDir();
    mkdirSync(dir, { recursive: true });

    // Atomic write
    const tmpPath = this.filePath + ".tmp";
    writeFileSync(tmpPath, JSON.stringify(state, null, 2));
    const { renameSync } = require("node:fs");
    renameSync(tmpPath, this.filePath);
  }

  load(): SleepSession[] {
    try {
      const raw = readFileSync(this.filePath, "utf-8");
      const state = JSON.parse(raw) as PersistedState;

      return state.sessions.map((s) => ({
        ...s.session,
        trigger: {
          ...s.session.trigger,
          satisfiedLeaves: new Set(s.session.trigger.satisfiedLeaves),
        },
      }));
    } catch {
      return [];
    }
  }
}
