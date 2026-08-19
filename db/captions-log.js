// db/captions-log.js - SQLite storage for voice caption transcripts (final results)
// Mirrors db/user-sessions.js. Retention is configurable (default 30 days).
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { STORAGE_PATHS, validateAndPrepareStoragePaths } from '../config/storage-paths.js';
import { getCaptionsRetentionDays } from '../lib/captions-config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

validateAndPrepareStoragePaths();
const DB_PATH = path.join(STORAGE_PATHS.DB_DIR, 'captions_log.db');

let db = null;

function ensureDataDir() {
    if (!fs.existsSync(STORAGE_PATHS.DB_DIR)) fs.mkdirSync(STORAGE_PATHS.DB_DIR, { recursive: true });
}

/**
 * Initialize captions_log DB and create table.
 */
export function initCaptionsLogDb() {
    ensureDataDir();
    db = new Database(DB_PATH);
    db.exec(`
        CREATE TABLE IF NOT EXISTS captions_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            room_id TEXT NOT NULL,
            peer_id TEXT NOT NULL,
            username TEXT NOT NULL,
            transcript TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            created_at_iso TEXT DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_captions_log_created_at ON captions_log(created_at);
        CREATE INDEX IF NOT EXISTS idx_captions_log_room ON captions_log(room_id);
    `);
    console.log('[DB] captions_log.db initialized');
}

/**
 * Insert a finalized caption line. Purges old records after insert.
 * @param {{roomId:string, peerId:string, username:string, transcript:string, createdAt?:number}} row
 */
export function insertCaptionLog(row) {
    if (!db) return;
    const transcript = String(row?.transcript || '').trim();
    if (!transcript) return;
    db.prepare(
        'INSERT INTO captions_log (room_id, peer_id, username, transcript, created_at) VALUES (?, ?, ?, ?, ?)'
    ).run(
        String(row.roomId || '-'),
        String(row.peerId || '-'),
        String(row.username || '-'),
        transcript,
        Number(row.createdAt) || Date.now()
    );
    deleteOlderThanDays(getCaptionsRetentionDays());
}

/**
 * Get captions paginated for admin list. Returns { captions, total }.
 * @param {number} page
 * @param {number} limit
 * @param {string} [roomId] optional room filter
 */
export function getCaptionsPaginated(page = 1, limit = 50, roomId = null) {
    if (!db) return { captions: [], total: 0 };
    const limitVal = Math.min(200, Math.max(1, Number(limit) || 50));
    const offset = Math.max(0, (Number(page) || 1) - 1) * limitVal;
    const where = roomId ? 'WHERE room_id = ?' : '';
    const countRow = roomId
        ? db.prepare(`SELECT COUNT(*) as total FROM captions_log ${where}`).get(roomId)
        : db.prepare('SELECT COUNT(*) as total FROM captions_log').get();
    const total = countRow?.total ?? 0;
    const sql = `SELECT id, room_id, peer_id, username, transcript, created_at
                 FROM captions_log ${where}
                 ORDER BY created_at DESC LIMIT ? OFFSET ?`;
    const captions = roomId
        ? db.prepare(sql).all(roomId, limitVal, offset)
        : db.prepare(sql).all(limitVal, offset);
    return { captions, total };
}

/**
 * Delete records older than the given number of days.
 * @param {number} days
 */
export function deleteOlderThanDays(days) {
    if (!db) return;
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    const result = db.prepare('DELETE FROM captions_log WHERE created_at < ?').run(cutoff);
    if (result.changes > 0) {
        console.log(`[DB] captions_log: removed ${result.changes} records older than ${days} days`);
    }
}
