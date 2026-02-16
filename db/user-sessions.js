// db/user-sessions.js - SQLite storage for login user sessions (30-day retention)
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'user_sessions.db');
const RETENTION_DAYS = 30;

let db = null;

function ensureDataDir() {
    if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
    }
}

/**
 * Initialize user_sessions DB and create table.
 */
export function initUserSessionsDb() {
    ensureDataDir();
    db = new Database(DB_PATH);
    db.exec(`
        CREATE TABLE IF NOT EXISTS user_sessions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT NOT NULL,
            login_time INTEGER NOT NULL,
            ip TEXT NOT NULL,
            browser TEXT NOT NULL,
            os TEXT NOT NULL,
            created_at TEXT DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_user_sessions_username ON user_sessions(username);
        CREATE INDEX IF NOT EXISTS idx_user_sessions_login_time ON user_sessions(login_time);
    `);
    console.log('[DB] user_sessions.db initialized');
}

/**
 * Insert a login session. Removes records older than RETENTION_DAYS after insert.
 */
export function insertSession({ username, loginTime, ip, browser, os }) {
    if (!db) return;
    const stmt = db.prepare(
        'INSERT INTO user_sessions (username, login_time, ip, browser, os) VALUES (?, ?, ?, ?, ?)'
    );
    stmt.run(
        String(username || '').trim(),
        Number(loginTime) || Date.now(),
        String(ip || '-'),
        String(browser || '-'),
        String(os || '-')
    );
    deleteOlderThanDays(RETENTION_DAYS);
}

/**
 * Get the latest session for a username (for modal when clicking chat username).
 */
export function getLatestSessionByUsername(username) {
    if (!db) return null;
    const stmt = db.prepare(
        'SELECT id, username, login_time, ip, browser, os FROM user_sessions WHERE username = ? ORDER BY login_time DESC LIMIT 1'
    );
    return stmt.get(String(username).trim()) || null;
}

/**
 * Get sessions paginated for admin list. Returns { sessions, total }.
 */
export function getSessionsPaginated(page = 1, limit = 50) {
    if (!db) return { sessions: [], total: 0 };
    const countRow = db.prepare('SELECT COUNT(*) as total FROM user_sessions').get();
    const total = countRow?.total ?? 0;
    const offset = Math.max(0, (Number(page) || 1) - 1) * Math.min(50, Math.max(1, Number(limit) || 50));
    const limitVal = Math.min(50, Math.max(1, Number(limit) || 50));
    const stmt = db.prepare(
        'SELECT id, username, login_time, ip, browser, os FROM user_sessions ORDER BY login_time DESC LIMIT ? OFFSET ?'
    );
    const sessions = stmt.all(limitVal, offset);
    return { sessions, total };
}

/**
 * Delete records older than the given number of days.
 */
export function deleteOlderThanDays(days) {
    if (!db) return;
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    const result = db.prepare('DELETE FROM user_sessions WHERE login_time < ?').run(cutoff);
    if (result.changes > 0) {
        console.log(`[DB] user_sessions: removed ${result.changes} records older than ${days} days`);
    }
}
