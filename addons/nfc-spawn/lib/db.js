// addons/nfc-spawn/lib/db.js — NFC スポーン SQLite CRUD
import { randomBytes } from 'node:crypto';

const SPAWN_TOKEN_RE = /^[A-Za-z0-9_-]{16,64}$/;
const LABEL_MAX_LEN = 128;
const NFC_UID_MAX_LEN = 64;

/**
 * @returns {string}
 */
export function generateSpawnToken() {
    return randomBytes(16).toString('base64url');
}

/**
 * @param {string} token
 * @returns {boolean}
 */
export function isValidSpawnTokenFormat(token) {
    return SPAWN_TOKEN_RE.test(String(token || '').trim());
}

/**
 * @param {import('better-sqlite3').Database} db
 * @returns {object[]}
 */
export function listNfcSpawns(db) {
    return db
        .prepare(
            `SELECT id, spawn_token, label, nfc_tag_uid, world_id, x, y, z, yaw, enabled, created_at, updated_at
             FROM nfc_spawns
             ORDER BY id ASC`
        )
        .all();
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {number} id
 * @returns {object|undefined}
 */
export function getNfcSpawnById(db, id) {
    return db
        .prepare(
            `SELECT id, spawn_token, label, nfc_tag_uid, world_id, x, y, z, yaw, enabled, created_at, updated_at
             FROM nfc_spawns WHERE id = ?`
        )
        .get(id);
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} token
 * @returns {object|undefined}
 */
export function getNfcSpawnByToken(db, token) {
    return db
        .prepare(
            `SELECT id, spawn_token, label, nfc_tag_uid, world_id, x, y, z, yaw, enabled, created_at, updated_at
             FROM nfc_spawns WHERE spawn_token = ?`
        )
        .get(token);
}

/**
 * @param {object} row
 * @returns {{ worldId: string, position: { x: number, y: number, z: number }, yaw: number, label: string }|null}
 */
export function rowToSpawnPlan(row) {
    if (!row) return null;
    return {
        worldId: String(row.world_id),
        position: { x: row.x, y: row.y, z: row.z },
        yaw: Number(row.yaw) || 0,
        label: String(row.label || ''),
    };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} token
 * @returns {{ worldId: string, position: { x: number, y: number, z: number }, yaw: number, label: string, enabled: boolean }|null}
 */
export function resolveSpawnByToken(db, token) {
    const row = getNfcSpawnByToken(db, token);
    if (!row) return null;
    const plan = rowToSpawnPlan(row);
    if (!plan) return null;
    return { ...plan, enabled: row.enabled === 1 };
}

/**
 * @param {unknown} body
 * @returns {{ ok: true, data: object } | { ok: false, error: string }}
 */
export function parseSpawnBody(body) {
    const label = typeof body?.label === 'string' ? body.label.trim() : '';
    if (!label || label.length > LABEL_MAX_LEN) {
        return { ok: false, error: 'invalid_label' };
    }
    const worldId = typeof body?.world_id === 'string' ? body.world_id.trim() : '';
    if (!worldId) return { ok: false, error: 'invalid_world_id' };
    const x = Number(body?.x);
    const y = Number(body?.y);
    const z = Number(body?.z);
    if (![x, y, z].every((n) => Number.isFinite(n))) {
        return { ok: false, error: 'invalid_position' };
    }
    const yaw = body?.yaw != null ? Number(body.yaw) : 0;
    if (!Number.isFinite(yaw)) return { ok: false, error: 'invalid_yaw' };
    let nfcTagUid = null;
    if (body?.nfc_tag_uid != null && String(body.nfc_tag_uid).trim() !== '') {
        const uid = String(body.nfc_tag_uid).trim();
        if (uid.length > NFC_UID_MAX_LEN) return { ok: false, error: 'invalid_nfc_tag_uid' };
        nfcTagUid = uid;
    }
    const enabled = body?.enabled === false || body?.enabled === 0 ? 0 : 1;
    return {
        ok: true,
        data: { label, worldId, x, y, z, yaw, nfcTagUid, enabled },
    };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {object} data
 * @returns {object}
 */
export function createNfcSpawn(db, data) {
    const token = generateSpawnToken();
    const result = db
        .prepare(
            `INSERT INTO nfc_spawns (spawn_token, label, nfc_tag_uid, world_id, x, y, z, yaw, enabled, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
        )
        .run(
            token,
            data.label,
            data.nfcTagUid,
            data.worldId,
            data.x,
            data.y,
            data.z,
            data.yaw,
            data.enabled
        );
    return getNfcSpawnById(db, Number(result.lastInsertRowid));
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {number} id
 * @param {object} data
 * @returns {object|undefined}
 */
export function updateNfcSpawn(db, id, data) {
    db.prepare(
        `UPDATE nfc_spawns
         SET label = ?, nfc_tag_uid = ?, world_id = ?, x = ?, y = ?, z = ?, yaw = ?, enabled = ?, updated_at = datetime('now')
         WHERE id = ?`
    ).run(
        data.label,
        data.nfcTagUid,
        data.worldId,
        data.x,
        data.y,
        data.z,
        data.yaw,
        data.enabled,
        id
    );
    return getNfcSpawnById(db, id);
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {number} id
 * @returns {boolean}
 */
export function deleteNfcSpawn(db, id) {
    const result = db.prepare('DELETE FROM nfc_spawns WHERE id = ?').run(id);
    return result.changes > 0;
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {number} id
 * @returns {object|undefined}
 */
export function regenerateSpawnToken(db, id) {
    const token = generateSpawnToken();
    const result = db
        .prepare(
            `UPDATE nfc_spawns SET spawn_token = ?, updated_at = datetime('now') WHERE id = ?`
        )
        .run(token, id);
    if (result.changes === 0) return undefined;
    return getNfcSpawnById(db, id);
}

/**
 * @param {object} row
 * @param {string} spawnUrl
 * @returns {object}
 */
export function serializeSpawnRow(row, spawnUrl) {
    return {
        id: row.id,
        spawn_token: row.spawn_token,
        label: row.label,
        nfc_tag_uid: row.nfc_tag_uid,
        world_id: row.world_id,
        x: row.x,
        y: row.y,
        z: row.z,
        yaw: row.yaw,
        enabled: row.enabled === 1,
        created_at: row.created_at,
        updated_at: row.updated_at,
        spawnUrl,
    };
}
