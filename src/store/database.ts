import Database from "better-sqlite3";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { runMigrations } from "./migrations.js";
import { NEBULA_DIR } from "../paths.js";

const DB_PATH = join(NEBULA_DIR, "nebula.db");

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!_db) {
    mkdirSync(NEBULA_DIR, { recursive: true });
    _db = new Database(DB_PATH);
    _db.pragma("journal_mode = WAL");
    _db.pragma("busy_timeout = 5000");
    _db.pragma("foreign_keys = ON");
    runMigrations(_db);
  }
  return _db;
}

export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}

export function getNebulaDir(): string {
  mkdirSync(NEBULA_DIR, { recursive: true });
  return NEBULA_DIR;
}
