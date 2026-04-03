import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { Database, type Statement } from "bun:sqlite";
import { RUNAI_DB_PATH } from "./config";

export interface InstalledModelRecord {
  id: string;
  name: string;
  path: string;
  sourceUrl: string | null;
  sourceRepo: string | null;
  sourceFile: string | null;
  installedAt: string;
}

interface RawRow {
  id: string;
  name: string;
  path: string;
  source_url: string | null;
  source_repo: string | null;
  source_file: string | null;
  installed_at: string;
}

function mapRow(row: RawRow): InstalledModelRecord {
  return {
    id: row.id,
    name: row.name,
    path: row.path,
    sourceUrl: row.source_url,
    sourceRepo: row.source_repo,
    sourceFile: row.source_file,
    installedAt: row.installed_at,
  };
}

let dbInstance: Database | null = null;
let dbInitialized = false;

let _stmtUpsert: Statement | null = null;
let _stmtDeleteByPath: Statement | null = null;
let _stmtDeleteById: Statement | null = null;
let _stmtListAll: Statement | null = null;
let _stmtGetById: Statement | null = null;

function getDb(): Database {
  if (dbInstance) return dbInstance;
  const dir = dirname(RUNAI_DB_PATH);
  if (!existsSync(dir)) {
    Bun.spawnSync(["mkdir", "-p", dir]);
  }
  dbInstance = new Database(RUNAI_DB_PATH);
  dbInstance.exec("PRAGMA journal_mode = WAL;");
  if (!dbInitialized) {
    dbInstance.exec(`
      CREATE TABLE IF NOT EXISTS installed_models (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        path TEXT NOT NULL UNIQUE,
        source_url TEXT,
        source_repo TEXT,
        source_file TEXT,
        installed_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_installed_models_installed_at
        ON installed_models(installed_at DESC);
    `);
    dbInitialized = true;
  }
  return dbInstance;
}

function stmtUpsert(): Statement {
  if (!_stmtUpsert) {
    _stmtUpsert = getDb().prepare(`
      INSERT INTO installed_models (id, name, path, source_url, source_repo, source_file, installed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name, path = excluded.path,
        source_url = excluded.source_url, source_repo = excluded.source_repo,
        source_file = excluded.source_file, installed_at = excluded.installed_at
    `);
  }
  return _stmtUpsert;
}

function stmtDeleteByPath(): Statement {
  if (!_stmtDeleteByPath) _stmtDeleteByPath = getDb().prepare("DELETE FROM installed_models WHERE path = ?");
  return _stmtDeleteByPath;
}

function stmtDeleteById(): Statement {
  if (!_stmtDeleteById) _stmtDeleteById = getDb().prepare("DELETE FROM installed_models WHERE id = ?");
  return _stmtDeleteById;
}

function stmtListAll(): Statement {
  if (!_stmtListAll) {
    _stmtListAll = getDb().prepare(`
      SELECT id, name, path, source_url, source_repo, source_file, installed_at
      FROM installed_models ORDER BY installed_at DESC
    `);
  }
  return _stmtListAll;
}

function stmtGetById(): Statement {
  if (!_stmtGetById) {
    _stmtGetById = getDb().prepare(`
      SELECT id, name, path, source_url, source_repo, source_file, installed_at
      FROM installed_models WHERE id = ? LIMIT 1
    `);
  }
  return _stmtGetById;
}

function invalidateStatements(): void {
  _stmtUpsert = null;
  _stmtDeleteByPath = null;
  _stmtDeleteById = null;
  _stmtListAll = null;
  _stmtGetById = null;
}

export function closeDb(): void {
  invalidateStatements();
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
    dbInitialized = false;
  }
}

export function upsertInstalledModel(input: {
  id: string;
  name: string;
  path: string;
  sourceUrl?: string | null;
  sourceRepo?: string | null;
  sourceFile?: string | null;
}): void {
  stmtUpsert().run(
    input.id,
    input.name,
    input.path,
    input.sourceUrl ?? null,
    input.sourceRepo ?? null,
    input.sourceFile ?? null,
    new Date().toISOString(),
  );
}

export function removeInstalledModelByPath(path: string): void {
  stmtDeleteByPath().run(path);
}

export function removeInstalledModelById(id: string): void {
  stmtDeleteById().run(id);
}

export function listInstalledModels(): InstalledModelRecord[] {
  const rows = stmtListAll().all() as RawRow[];
  return rows.map(mapRow);
}

export function getInstalledModelById(id: string): InstalledModelRecord | null {
  const row = stmtGetById().get(id) as RawRow | null;
  if (!row) return null;
  return mapRow(row);
}

export function isModelFilePresent(path: string): boolean {
  return existsSync(path);
}
