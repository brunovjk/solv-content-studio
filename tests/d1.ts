import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";

/** Real SQLite with the small async D1 surface used by this app; no network or persistent files. */
export function sqliteD1() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync(new URL("../migrations/0001_initial.sql", import.meta.url), "utf8"));
  sqlite.exec(readFileSync(new URL("../migrations/0002_illustrations.sql", import.meta.url), "utf8"));
  const normalize = (row: Record<string, unknown> | undefined) => row ? Object.fromEntries(Object.entries(row).map(([name, value]) => [name, value instanceof Uint8Array ? [...value] : value])) : null;
  const parameter = (value: unknown) => value instanceof ArrayBuffer ? new Uint8Array(value) : value;
  const prepare = (sql: string, values: unknown[] = []) => ({
    bind(...parameters: unknown[]) { return prepare(sql, parameters); },
    async first() { return normalize(sqlite.prepare(sql).get(...values.map(parameter) as never[])); },
    async all() { return { results: sqlite.prepare(sql).all(...values.map(parameter) as never[]).map(normalize), success: true, meta: {} }; },
    async run() {
      const result = sqlite.prepare(sql).run(...values.map(parameter) as never[]);
      return { success: true, results: [], meta: { changes: Number(result.changes) } };
    },
  });
  return { db: { prepare } as unknown as D1Database, sqlite, close: () => sqlite.close() };
}
