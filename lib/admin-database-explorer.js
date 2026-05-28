// lib/admin-database-explorer.js — 管理画面用 SQLite 閲覧 API（読み取り専用）
import express from 'express';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { STORAGE_PATHS } from '../config/storage-paths.js';

/** @type {Record<string, string>} */
const CORE_DB_FILES = {
    users: 'users.db',
    user_sessions: 'user_sessions.db',
    addons_registry: 'addons_registry.db',
};

/** @type {Record<string, string>} */
const CORE_DB_LABELS = {
    users: 'ユーザー',
    user_sessions: 'ログインセッション',
    addons_registry: 'アドオンレジストリ',
};

const TABLE_NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const PLUGIN_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;
const MAX_SQL_ROWS = 200;

/** @type {Set<string>} */
const SENSITIVE_COLUMN_NAMES = new Set(['password_hash', 'password', 'secret', 'token']);

/**
 * @param {string} dbId
 * @returns {string|null} 絶対パス。不正 ID は null
 */
export function resolveDatabasePath(dbId) {
    const id = String(dbId || '').trim();
    if (!id) return null;
    if (id.startsWith('core/')) {
        const key = id.slice(5);
        const file = CORE_DB_FILES[key];
        if (!file) return null;
        return path.join(STORAGE_PATHS.DB_DIR, file);
    }
    if (id.startsWith('plugin/')) {
        const pluginId = id.slice(7);
        if (!PLUGIN_ID_RE.test(pluginId)) return null;
        return path.join(STORAGE_PATHS.PLUGIN_DATABASES_DIR, `${pluginId}.db`);
    }
    return null;
}

/**
 * @param {string} absPath
 * @returns {import('better-sqlite3').Database|null}
 */
function openReadonlyDatabase(absPath) {
    if (!fs.existsSync(absPath)) return null;
    try {
        return new Database(absPath, { readonly: true, fileMustExist: true });
    } catch {
        return null;
    }
}

/**
 * @param {string} absPath
 * @returns {{ sizeBytes: number, mtimeMs: number }|null}
 */
function fileStats(absPath) {
    try {
        const st = fs.statSync(absPath);
        if (!st.isFile()) return null;
        return { sizeBytes: st.size, mtimeMs: st.mtimeMs };
    } catch {
        return null;
    }
}

/**
 * 登録済み・存在する SQLite ファイル一覧
 */
export function listAdminDatabases() {
    /** @type {{ id: string, label: string, group: string, fileName: string, exists: boolean, sizeBytes: number|null, mtimeMs: number|null }[]} */
    const out = [];

    for (const [key, fileName] of Object.entries(CORE_DB_FILES)) {
        const abs = path.join(STORAGE_PATHS.DB_DIR, fileName);
        const st = fileStats(abs);
        out.push({
            id: `core/${key}`,
            label: CORE_DB_LABELS[key] || key,
            group: 'core',
            fileName,
            exists: Boolean(st),
            sizeBytes: st?.sizeBytes ?? null,
            mtimeMs: st?.mtimeMs ?? null,
        });
    }

    const pluginDir = STORAGE_PATHS.PLUGIN_DATABASES_DIR;
    /** @type {string[]} */
    let pluginFiles = [];
    try {
        if (fs.existsSync(pluginDir)) {
            pluginFiles = fs
                .readdirSync(pluginDir)
                .filter((f) => f.endsWith('.db'))
                .sort((a, b) => a.localeCompare(b));
        }
    } catch {
        pluginFiles = [];
    }

    for (const fileName of pluginFiles) {
        const pluginId = fileName.replace(/\.db$/i, '');
        if (!PLUGIN_ID_RE.test(pluginId)) continue;
        const abs = path.join(pluginDir, fileName);
        const st = fileStats(abs);
        out.push({
            id: `plugin/${pluginId}`,
            label: pluginId,
            group: 'plugin',
            fileName,
            exists: Boolean(st),
            sizeBytes: st?.sizeBytes ?? null,
            mtimeMs: st?.mtimeMs ?? null,
        });
    }

    return out;
}

/**
 * @param {string} dbId
 * @returns {{ tables: { name: string, type: string, rowCount: number|null }[] }|null}
 */
export function listAdminDatabaseTables(dbId) {
    const abs = resolveDatabasePath(dbId);
    if (!abs) return null;
    const db = openReadonlyDatabase(abs);
    if (!db) return { tables: [], missing: true };

    try {
        const rows = db
            .prepare(
                `SELECT name, type FROM sqlite_master
                 WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%'
                 ORDER BY type ASC, name ASC`
            )
            .all();
        /** @type {{ name: string, type: string, rowCount: number|null }[]} */
        const tables = [];
        for (const row of rows) {
            const name = String(row.name || '');
            if (!TABLE_NAME_RE.test(name)) continue;
            let rowCount = null;
            try {
                const quoted = `"${name.replace(/"/g, '""')}"`;
                const c = db.prepare(`SELECT COUNT(*) AS c FROM ${quoted}`).get();
                rowCount = typeof c?.c === 'number' ? c.c : Number(c?.c) || 0;
            } catch {
                rowCount = null;
            }
            tables.push({ name, type: String(row.type || 'table'), rowCount });
        }
        return { tables, missing: false };
    } finally {
        db.close();
    }
}

/**
 * @param {string} dbId
 * @param {string} tableName
 */
export function getAdminTableSchema(dbId, tableName) {
    const abs = resolveDatabasePath(dbId);
    if (!abs || !TABLE_NAME_RE.test(tableName)) return null;
    const db = openReadonlyDatabase(abs);
    if (!db) return null;

    try {
        const quoted = `"${tableName.replace(/"/g, '""')}"`;
        const columns = db.prepare(`PRAGMA table_info(${quoted})`).all();
        const indexes = db.prepare(`PRAGMA index_list(${quoted})`).all();
        return {
            columns: columns.map((c) => ({
                cid: c.cid,
                name: String(c.name),
                type: String(c.type || ''),
                notnull: Boolean(c.notnull),
                dflt_value: c.dflt_value,
                pk: Boolean(c.pk),
            })),
            indexes: indexes.map((i) => ({
                name: String(i.name),
                unique: Boolean(i.unique),
                origin: String(i.origin || ''),
            })),
        };
    } finally {
        db.close();
    }
}

/**
 * @param {unknown} value
 * @param {string} columnName
 */
function serializeCell(value, columnName) {
    if (SENSITIVE_COLUMN_NAMES.has(String(columnName).toLowerCase())) {
        return { value: '[redacted]', redacted: true };
    }
    if (value === null || value === undefined) {
        return { value: null, redacted: false };
    }
    if (typeof value === 'bigint') {
        return { value: value.toString(), redacted: false };
    }
    if (Buffer.isBuffer(value)) {
        return { value: `[binary ${value.length} bytes]`, redacted: false };
    }
    if (typeof value === 'object') {
        try {
            return { value: JSON.stringify(value), redacted: false };
        } catch {
            return { value: String(value), redacted: false };
        }
    }
    return { value, redacted: false };
}

/**
 * @param {string} dbId
 * @param {string} tableName
 * @param {{ offset?: number, limit?: number, orderBy?: string, orderDir?: string }} opts
 */
export function queryAdminTableRows(dbId, tableName, opts = {}) {
    const abs = resolveDatabasePath(dbId);
    if (!abs || !TABLE_NAME_RE.test(tableName)) return null;
    const db = openReadonlyDatabase(abs);
    if (!db) return { missing: true, columns: [], rows: [], total: 0 };

    const offset = Math.max(0, Number(opts.offset) || 0);
    const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, Number(opts.limit) || DEFAULT_PAGE_SIZE));
    const orderDir = String(opts.orderDir || 'ASC').toUpperCase() === 'DESC' ? 'DESC' : 'ASC';

    try {
        const quoted = `"${tableName.replace(/"/g, '""')}"`;
        const schema = db.prepare(`PRAGMA table_info(${quoted})`).all();
        const columnNames = schema.map((c) => String(c.name));
        if (!columnNames.length) return null;

        let orderCol = 'rowid';
        const reqOrder = String(opts.orderBy || '').trim();
        if (reqOrder && columnNames.includes(reqOrder)) {
            orderCol = `"${reqOrder.replace(/"/g, '""')}"`;
        } else {
            try {
                db.prepare(`SELECT rowid FROM ${quoted} LIMIT 1`).get();
            } catch {
                orderCol = `"${columnNames[0].replace(/"/g, '""')}"`;
            }
        }

        const totalRow = db.prepare(`SELECT COUNT(*) AS c FROM ${quoted}`).get();
        const total = typeof totalRow?.c === 'number' ? totalRow.c : Number(totalRow?.c) || 0;

        const sql = `SELECT * FROM ${quoted} ORDER BY ${orderCol} ${orderDir} LIMIT ? OFFSET ?`;
        const rawRows = db.prepare(sql).all(limit, offset);

        const rows = rawRows.map((row) => {
            /** @type {Record<string, { value: unknown, redacted: boolean }>} */
            const cells = {};
            for (const col of columnNames) {
                cells[col] = serializeCell(row[col], col);
            }
            return cells;
        });

        return {
            missing: false,
            columns: columnNames,
            rows,
            total,
            offset,
            limit,
            orderBy: reqOrder || (orderCol === 'rowid' ? 'rowid' : columnNames[0]),
            orderDir,
        };
    } finally {
        db.close();
    }
}

/**
 * SELECT のみ許可（単一ステートメント）
 * @param {string} sql
 * @returns {{ ok: true } | { ok: false, error: string }}
 */
export function validateReadonlySelectSql(sql) {
    const trimmed = String(sql || '').trim();
    if (!trimmed) return { ok: false, error: 'SQL が空です' };
    if (trimmed.includes(';')) {
        const parts = trimmed.split(';').filter((p) => p.trim());
        if (parts.length !== 1) return { ok: false, error: '複数ステートメントは禁止です' };
    }
    const upper = trimmed.toUpperCase();
    if (!upper.startsWith('SELECT') && !upper.startsWith('WITH')) {
        return { ok: false, error: 'SELECT または WITH のみ実行できます' };
    }
    const forbidden =
        /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|REPLACE|ATTACH|DETACH|PRAGMA|VACUUM|REINDEX)\b/i;
    if (forbidden.test(trimmed)) {
        return { ok: false, error: '変更系・PRAGMA・ATTACH は禁止です' };
    }
    return { ok: true };
}

/**
 * @param {string} dbId
 * @param {string} sql
 */
export function runAdminReadonlyQuery(dbId, sql) {
    const abs = resolveDatabasePath(dbId);
    if (!abs) return null;
    const check = validateReadonlySelectSql(sql);
    if (!check.ok) return { error: check.error };

    const db = openReadonlyDatabase(abs);
    if (!db) return { missing: true, columns: [], rows: [] };

    const trimmed = String(sql).trim().replace(/;+\s*$/, '');

    try {
        const stmt = db.prepare(trimmed);
        const rawRows = stmt.all();
        const limited = rawRows.slice(0, MAX_SQL_ROWS);
        /** @type {string[]} */
        const columns =
            limited.length > 0
                ? Object.keys(limited[0])
                : stmt.columns().map((c) => String(c.name));

        const rows = limited.map((row) => {
            /** @type {Record<string, { value: unknown, redacted: boolean }>} */
            const cells = {};
            for (const col of columns) {
                cells[col] = serializeCell(row[col], col);
            }
            return cells;
        });

        return {
            missing: false,
            columns,
            rows,
            truncated: rawRows.length > MAX_SQL_ROWS,
            rowCount: rawRows.length,
        };
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return { error: msg };
    } finally {
        db.close();
    }
}

/**
 * @param {import('express').Express} app
 */
export function registerAdminDatabaseExplorerRoutes(app) {
    app.get('/admin/database/databases', (_req, res) => {
        try {
            res.json({ ok: true, databases: listAdminDatabases() });
        } catch (e) {
            console.error('GET /admin/database/databases', e);
            res.status(500).json({ ok: false, error: 'list_failed' });
        }
    });

    app.get('/admin/database/databases/:dbId/tables', (req, res) => {
        const dbId = decodeURIComponent(String(req.params.dbId || ''));
        const result = listAdminDatabaseTables(dbId);
        if (result === null) return res.status(400).json({ ok: false, error: 'invalid_database' });
        res.json({ ok: true, dbId, ...result });
    });

    app.get('/admin/database/databases/:dbId/tables/:table/schema', (req, res) => {
        const dbId = decodeURIComponent(String(req.params.dbId || ''));
        const table = String(req.params.table || '');
        const schema = getAdminTableSchema(dbId, table);
        if (!schema) return res.status(404).json({ ok: false, error: 'not_found' });
        res.json({ ok: true, dbId, table, schema });
    });

    app.get('/admin/database/databases/:dbId/tables/:table/rows', (req, res) => {
        const dbId = decodeURIComponent(String(req.params.dbId || ''));
        const table = String(req.params.table || '');
        const result = queryAdminTableRows(dbId, table, {
            offset: req.query.offset,
            limit: req.query.limit,
            orderBy: req.query.orderBy,
            orderDir: req.query.orderDir,
        });
        if (!result) return res.status(404).json({ ok: false, error: 'not_found' });
        if (result.missing) return res.status(404).json({ ok: false, error: 'database_missing' });
        res.json({ ok: true, dbId, table, ...result });
    });

    app.post('/admin/database/query', express.json({ limit: '32kb' }), (req, res) => {
        const dbId = String(req.body?.dbId || '').trim();
        const sql = String(req.body?.sql || '');
        if (!dbId) return res.status(400).json({ ok: false, error: 'dbId required' });
        const result = runAdminReadonlyQuery(dbId, sql);
        if (result === null) return res.status(400).json({ ok: false, error: 'invalid_database' });
        if (result.error) return res.status(400).json({ ok: false, error: result.error });
        if (result.missing) return res.status(404).json({ ok: false, error: 'database_missing' });
        res.json({ ok: true, dbId, ...result });
    });
}
