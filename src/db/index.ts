import { Database } from 'bun:sqlite';
import { MIGRATIONS, MIGRATION_TABLE_SQL } from './schema';

let db: Database | null = null;

export function getDatabase(path?: string): Database {
  if (db) return db;

  const dbPath = path || `${process.cwd()}/autoagent.db`;
  db = new Database(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');

  runMigrations(db);
  return db;
}

function runMigrations(database: Database): void {
  database.exec(MIGRATION_TABLE_SQL);

  const appliedVersions = new Set<number>();
  const rows = database.query('SELECT version FROM __migrations WHERE success = 1').all() as { version: number }[];
  for (const row of rows) {
    appliedVersions.add(row.version);
  }

  for (let i = 0; i < MIGRATIONS.length; i++) {
    const version = i + 1;
    if (appliedVersions.has(version)) continue;

    const sql = MIGRATIONS[i];
    const checksum = Bun.hash(sql);
    const startTime = Date.now();

    try {
      database.exec(sql);

      database.run(
        `INSERT INTO __migrations (version, description, success, checksum, execution_time)
         VALUES (?, ?, ?, ?, ?)`,
        [version, `Migration ${version}`, 1, checksum, Date.now() - startTime]
      );
    } catch (err) {
      database.run(
        `INSERT INTO __migrations (version, description, success, checksum, execution_time)
         VALUES (?, ?, ?, ?, ?)`,
        [version, `Migration ${version}`, 0, checksum, Date.now() - startTime]
      );
      throw err;
    }
  }
}

export function closeDatabase(): void {
  if (db) {
    db.close();
    db = null;
  }
}
