// db/users.js - SQLite user storage for students and teachers
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { STORAGE_PATHS, validateAndPrepareStoragePaths } from '../config/storage-paths.js';

/**
 * @param {unknown} password
 */
function assertPasswordPolicy(password) {
    const check = validateUserPassword(password);
    if (!check.ok) {
        const err = new Error(check.error);
        err.code = 'PASSWORD_POLICY';
        err.minLength = check.minLength;
        throw err;
    }
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

validateAndPrepareStoragePaths();
const DB_PATH = path.join(STORAGE_PATHS.DB_DIR, 'users.db');
const BCRYPT_ROUNDS = 10;

let db = null;

/** Ensure data directory exists */
function ensureDataDir() {
    if (!fs.existsSync(STORAGE_PATHS.DB_DIR)) fs.mkdirSync(STORAGE_PATHS.DB_DIR, { recursive: true });
}

/** Initialize database and create tables if they do not exist */
export function initDb() {
    ensureDataDir();
    db = new Database(DB_PATH);

    db.exec(`
        CREATE TABLE IF NOT EXISTS students (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            display_name TEXT NOT NULL,
            created_at TEXT DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS teachers (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            display_name TEXT NOT NULL,
            created_at TEXT DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS bench_users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            run_id TEXT NOT NULL,
            username TEXT UNIQUE NOT NULL,
            display_name TEXT NOT NULL,
            created_at TEXT DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_bench_users_run_id ON bench_users(run_id);
    `);

    console.log('[DB] SQLite users.db initialized');
}

/** Verify student login. Returns { id, username, display_name } or null */
export function verifyStudent(username, password) {
    if (!db) return null;
    const stmt = db.prepare('SELECT id, username, password_hash, display_name FROM students WHERE username = ?');
    const row = stmt.get(username.trim());
    if (!row) return null;
    if (!bcrypt.compareSync(password, row.password_hash)) return null;
    return { id: row.id, username: row.username, displayName: row.display_name };
}

/** Verify teacher login. Returns { id, username, display_name } or null */
export function verifyTeacher(username, password) {
    if (!db) return null;
    const stmt = db.prepare('SELECT id, username, password_hash, display_name FROM teachers WHERE username = ?');
    const row = stmt.get(username.trim());
    if (!row) return null;
    if (!bcrypt.compareSync(password, row.password_hash)) return null;
    return { id: row.id, username: row.username, displayName: row.display_name };
}

/** Register a new student. Returns { id, username, display_name } or throws */
export function registerStudent(username, password, displayName) {
    if (!db) throw new Error('Database not initialized');
    assertPasswordPolicy(password);
    const hash = bcrypt.hashSync(password, BCRYPT_ROUNDS);
    const u = username.trim();
    const d = (displayName || u).trim();
    const stmt = db.prepare('INSERT INTO students (username, password_hash, display_name) VALUES (?, ?, ?)');
    const result = stmt.run(u, hash, d);
    return { id: result.lastInsertRowid, username: u, displayName: d };
}

/** Register a new teacher. Returns { id, username, display_name } or throws */
export function registerTeacher(username, password, displayName) {
    if (!db) throw new Error('Database not initialized');
    assertPasswordPolicy(password);
    const hash = bcrypt.hashSync(password, BCRYPT_ROUNDS);
    const u = username.trim();
    const d = (displayName || u).trim();
    const stmt = db.prepare('INSERT INTO teachers (username, password_hash, display_name) VALUES (?, ?, ?)');
    const result = stmt.run(u, hash, d);
    return { id: result.lastInsertRowid, username: u, displayName: d };
}

/** List all students. Returns array of { id, username, display_name, created_at } */
export function listStudents() {
    if (!db) return [];
    const stmt = db.prepare('SELECT id, username, display_name, created_at FROM students ORDER BY id');
    return stmt.all();
}

/** List all teachers. Returns array of { id, username, display_name, created_at } */
export function listTeachers() {
    if (!db) return [];
    const stmt = db.prepare('SELECT id, username, display_name, created_at FROM teachers ORDER BY id');
    return stmt.all();
}

/** Update student by id. username, displayName optional; password optional (if provided, update hash). */
export function updateStudent(id, { username, displayName, password } = {}) {
    if (!db) throw new Error('Database not initialized');
    const row = db.prepare('SELECT id, username, display_name FROM students WHERE id = ?').get(id);
    if (!row) return null;
    const u = username !== undefined ? String(username).trim() : row.username;
    const d = displayName !== undefined ? String(displayName).trim() : row.display_name;
    if (password !== undefined && password !== null && String(password).length > 0) {
        assertPasswordPolicy(password);
        const hash = bcrypt.hashSync(password, BCRYPT_ROUNDS);
        db.prepare('UPDATE students SET username = ?, display_name = ?, password_hash = ? WHERE id = ?').run(u, d, hash, id);
    } else {
        db.prepare('UPDATE students SET username = ?, display_name = ? WHERE id = ?').run(u, d, id);
    }
    return { id, username: u, displayName: d };
}

/** Update teacher by id. Same as updateStudent. */
export function updateTeacher(id, { username, displayName, password } = {}) {
    if (!db) throw new Error('Database not initialized');
    const row = db.prepare('SELECT id, username, display_name FROM teachers WHERE id = ?').get(id);
    if (!row) return null;
    const u = username !== undefined ? String(username).trim() : row.username;
    const d = displayName !== undefined ? String(displayName).trim() : row.display_name;
    if (password !== undefined && password !== null && String(password).length > 0) {
        assertPasswordPolicy(password);
        const hash = bcrypt.hashSync(password, BCRYPT_ROUNDS);
        db.prepare('UPDATE teachers SET username = ?, display_name = ?, password_hash = ? WHERE id = ?').run(u, d, hash, id);
    } else {
        db.prepare('UPDATE teachers SET username = ?, display_name = ? WHERE id = ?').run(u, d, id);
    }
    return { id, username: u, displayName: d };
}

/** Delete student by id. Returns true if deleted. */
export function deleteStudent(id) {
    if (!db) return false;
    const result = db.prepare('DELETE FROM students WHERE id = ?').run(id);
    return result.changes > 0;
}

/** Delete teacher by id. Returns true if deleted. */
export function deleteTeacher(id) {
    if (!db) return false;
    const result = db.prepare('DELETE FROM teachers WHERE id = ?').run(id);
    return result.changes > 0;
}

/**
 * ベンチ run 用一時ユーザーを作成する
 * @param {string} runId
 * @param {number} count
 * @returns {Array<{ id: number, username: string, displayName: string }>}
 */
export function createBenchUsers(runId, count) {
    if (!db) throw new Error('Database not initialized');
    const rid = String(runId || '').trim();
    if (!rid) throw new Error('runId required');
    const n = Math.max(0, Math.min(200, Math.floor(count)));
    const hash = bcrypt.hashSync(crypto.randomBytes(16).toString('hex'), BCRYPT_ROUNDS);
    const insert = db.prepare(
        'INSERT INTO bench_users (run_id, username, display_name) VALUES (?, ?, ?)'
    );
    /** @type {Array<{ id: number, username: string, displayName: string }>} */
    const created = [];
    const tx = db.transaction(() => {
        for (let i = 0; i < n; i++) {
            const username = `bench-${rid}-${i + 1}`;
            const displayName = username;
            const result = insert.run(rid, username, displayName);
            created.push({
                id: Number(result.lastInsertRowid),
                username,
                displayName,
            });
        }
    });
    tx();
    return created;
}

/**
 * run に紐づく bench ユーザーを削除する
 * @param {string} runId
 * @returns {number} deleted count
 */
export function deleteBenchUsers(runId) {
    if (!db) return 0;
    const rid = String(runId || '').trim();
    if (!rid) return 0;
    const result = db.prepare('DELETE FROM bench_users WHERE run_id = ?').run(rid);
    return result.changes;
}

/**
 * bench_users の件数（db-sqlite ベンチ用）
 * @returns {number}
 */
export function countBenchUsers() {
    if (!db) return 0;
    const row = db.prepare('SELECT COUNT(*) AS c FROM bench_users').get();
    return row?.c ?? 0;
}
