// lib/plugin-migrations.js — addon 専用 DB の SQL マイグレーション
import fs from 'node:fs';
import path from 'node:path';

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} migrationsDir absolute path
 */
export function runPluginMigrations(db, migrationsDir) {
    if (!fs.existsSync(migrationsDir)) return;

    db.exec(`
        CREATE TABLE IF NOT EXISTS _plugin_migrations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL UNIQUE,
            applied_at TEXT DEFAULT (datetime('now'))
        );
    `);

    const applied = new Set(
        db.prepare('SELECT name FROM _plugin_migrations').all().map((r) => r.name)
    );

    const files = fs
        .readdirSync(migrationsDir)
        .filter((f) => f.endsWith('.sql'))
        .sort();

    for (const file of files) {
        if (applied.has(file)) continue;
        const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
        db.exec('BEGIN');
        try {
            db.exec(sql);
            db.prepare('INSERT INTO _plugin_migrations (name) VALUES (?)').run(file);
            db.exec('COMMIT');
        } catch (e) {
            db.exec('ROLLBACK');
            throw e;
        }
    }
}
