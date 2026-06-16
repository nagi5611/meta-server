// addons/nfc-spawn/lib/db.js — NFC スポーン SQLite CRUD
import { randomBytes } from 'node:crypto';

const SPAWN_TOKEN_RE = /^[A-Za-z0-9_-]{16,64}$/;
const LABEL_MAX_LEN = 128;
const NFC_UID_MAX_LEN = 64;
const SPAWN_TYPES = new Set(['teleport', 'instance']);
const LOAD_RADIUS_MIN = 1;
const LOAD_RADIUS_MAX = 500;

const SELECT_COLS = `id, spawn_token, label, nfc_tag_uid, world_id, x, y, z, yaw, enabled,
    type, load_radius, instance_manifest_path, baked_at, bake_revision,
    created_at, updated_at`;

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
    return db.prepare(`SELECT ${SELECT_COLS} FROM nfc_spawns ORDER BY id ASC`).all();
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {number} id
 * @returns {object|undefined}
 */
export function getNfcSpawnById(db, id) {
    return db.prepare(`SELECT ${SELECT_COLS} FROM nfc_spawns WHERE id = ?`).get(id);
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} token
 * @returns {object|undefined}
 */
export function getNfcSpawnByToken(db, token) {
    return db.prepare(`SELECT ${SELECT_COLS} FROM nfc_spawns WHERE spawn_token = ?`).get(token);
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
    const type = String(row.type || 'teleport');
    if (type !== 'teleport') return null;
    const plan = rowToSpawnPlan(row);
    if (!plan) return null;
    return { ...plan, enabled: row.enabled === 1 };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} token
 * @returns {{ id: number, label: string, enabled: boolean, manifestPath: string, bakeRevision: number }|null}
 */
export function resolveInstanceByToken(db, token) {
    const row = getNfcSpawnByToken(db, token);
    if (!row) return null;
    if (String(row.type || '') !== 'instance') return null;
    if (!row.baked_at || !row.instance_manifest_path) return null;
    return {
        id: row.id,
        label: String(row.label || ''),
        enabled: row.enabled === 1,
        manifestPath: String(row.instance_manifest_path),
        bakeRevision: Number(row.bake_revision) || 0,
    };
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
    const typeRaw = typeof body?.type === 'string' ? body.type.trim() : 'teleport';
    const type = SPAWN_TYPES.has(typeRaw) ? typeRaw : 'teleport';
    let loadRadius = null;
    if (type === 'instance') {
        loadRadius = Number(body?.load_radius);
        if (!Number.isFinite(loadRadius) || loadRadius < LOAD_RADIUS_MIN || loadRadius > LOAD_RADIUS_MAX) {
            return { ok: false, error: 'invalid_load_radius' };
        }
    }
    return {
        ok: true,
        data: { label, worldId, x, y, z, yaw, nfcTagUid, enabled, type, loadRadius },
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
            `INSERT INTO nfc_spawns (
                spawn_token, label, nfc_tag_uid, world_id, x, y, z, yaw, enabled,
                type, load_radius, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
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
            data.enabled,
            data.type || 'teleport',
            data.loadRadius
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
    const existing = getNfcSpawnById(db, id);
    const typeChanged =
        existing && data.type !== undefined && String(existing.type || 'teleport') !== String(data.type);
    const positionChanged =
        existing &&
        (existing.x !== data.x ||
            existing.y !== data.y ||
            existing.z !== data.z ||
            (data.loadRadius != null && existing.load_radius !== data.loadRadius));
    const clearBake = typeChanged || (existing?.type === 'instance' && positionChanged);

    db.prepare(
        `UPDATE nfc_spawns
         SET label = ?, nfc_tag_uid = ?, world_id = ?, x = ?, y = ?, z = ?, yaw = ?, enabled = ?,
             type = ?, load_radius = ?,
             instance_manifest_path = CASE WHEN ? THEN NULL ELSE instance_manifest_path END,
             baked_at = CASE WHEN ? THEN NULL ELSE baked_at END,
             updated_at = datetime('now')
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
        data.type || 'teleport',
        data.loadRadius,
        clearBake ? 1 : 0,
        clearBake ? 1 : 0,
        id
    );
    if (clearBake) {
        db.prepare('DELETE FROM nfc_instance_entries WHERE spawn_id = ?').run(id);
    }
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
        .prepare(`UPDATE nfc_spawns SET spawn_token = ?, updated_at = datetime('now') WHERE id = ?`)
        .run(token, id);
    if (result.changes === 0) return undefined;
    return getNfcSpawnById(db, id);
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {number} spawnId
 * @param {{ manifestPath: string, entries: object[] }} bakeResult
 * @returns {object|undefined}
 */
export function recordInstanceBake(db, spawnId, bakeResult) {
    const existing = getNfcSpawnById(db, spawnId);
    if (!existing) return undefined;
    const revision = (Number(existing.bake_revision) || 0) + 1;
    const bakedAt = new Date().toISOString();
    db.prepare(
        `UPDATE nfc_spawns
         SET instance_manifest_path = ?, baked_at = ?, bake_revision = ?, updated_at = datetime('now')
         WHERE id = ?`
    ).run(bakeResult.manifestPath, bakedAt, revision, spawnId);
    db.prepare('DELETE FROM nfc_instance_entries WHERE spawn_id = ?').run(spawnId);
    const insert = db.prepare(
        `INSERT INTO nfc_instance_entries (spawn_id, world_model_index, entry_kind, prefab_manifest, part_indices, source_path)
         VALUES (?, ?, ?, ?, ?, ?)`
    );
    for (const e of bakeResult.entries) {
        insert.run(
            spawnId,
            e.worldModelIndex,
            e.entryKind,
            e.prefabManifest || null,
            e.partIndices != null ? JSON.stringify(e.partIndices) : null,
            e.sourcePath || null
        );
    }
    return getNfcSpawnById(db, spawnId);
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {number} spawnId
 * @returns {object[]}
 */
export function listInstanceEntries(db, spawnId) {
    return db
        .prepare(
            `SELECT id, spawn_id, world_model_index, entry_kind, prefab_manifest, part_indices, source_path
             FROM nfc_instance_entries WHERE spawn_id = ? ORDER BY id ASC`
        )
        .all(spawnId);
}

/**
 * @param {object} row
 * @param {string} spawnUrl
 * @param {string} instanceUrl
 * @returns {object}
 */
export function serializeSpawnRow(row, spawnUrl, instanceUrl) {
    const type = String(row.type || 'teleport');
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
        type,
        load_radius: row.load_radius,
        instance_manifest_path: row.instance_manifest_path,
        baked_at: row.baked_at,
        bake_revision: row.bake_revision ?? 0,
        hasBake: !!(row.baked_at && row.instance_manifest_path),
        created_at: row.created_at,
        updated_at: row.updated_at,
        spawnUrl: type === 'teleport' ? spawnUrl : null,
        instanceUrl: type === 'instance' ? instanceUrl : null,
    };
}
