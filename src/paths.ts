import { join } from "node:path";
import { homedir } from "node:os";

/** Root config/data directory. Override with NEBULA_HOME env var. */
export const NEBULA_DIR = process.env.NEBULA_HOME ?? join(homedir(), ".nebula");
