// addons/qr-ar/lib/db.js — QR-AR カード SQLite CRUD
const CARD_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const LABEL_MAX_LEN = 128;

const SELECT_COLS =
    'id, card_id, label, model_filename, model_scale, offset_x, offset_y, offset_z, qr_physical_size_m, enabled, created_at, updated_at';

/**
 * @param {string} cardId
 * @returns {boolean}
 */
export function isValidCardIdFormat(cardId) {
    return CARD_ID_RE.test(String(cardId || '').trim());
}

/**
 * @param {import('better-sqlite3').Database} db
 * @returns {object[]}
 */
export function listQrArCards(db) {
    return db.prepare(`SELECT ${SELECT_COLS} FROM qr_ar_cards ORDER BY id ASC`).all();
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {number} id
 * @returns {object|undefined}
 */
export function getQrArCardById(db, id) {
    return db.prepare(`SELECT ${SELECT_COLS} FROM qr_ar_cards WHERE id = ?`).get(id);
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} cardId
 * @returns {object|undefined}
 */
export function getQrArCardByCardId(db, cardId) {
    return db.prepare(`SELECT ${SELECT_COLS} FROM qr_ar_cards WHERE card_id = ?`).get(cardId);
}

/**
 * @param {object} row
 * @param {string} [modelUrl]
 */
export function serializeQrArCard(row, modelUrl) {
    if (!row) return null;
    const hasModel = Boolean(row.model_filename);
    return {
        id: row.id,
        cardId: String(row.card_id),
        label: String(row.label || ''),
        modelUrl: hasModel ? modelUrl || null : null,
        modelScale: Number(row.model_scale) || 1,
        offset: {
            x: Number(row.offset_x) || 0,
            y: Number(row.offset_y) || 0,
            z: Number(row.offset_z) || 0,
        },
        qrPhysicalSizeM: Number(row.qr_physical_size_m) || 0.02,
        enabled: row.enabled === 1,
        createdAt: String(row.created_at || ''),
        updatedAt: String(row.updated_at || ''),
        hasModel,
    };
}

/**
 * @param {unknown} raw
 * @returns {number}
 */
function parseFiniteNumber(raw, fallback) {
    const n = Number(raw);
    return Number.isFinite(n) ? n : fallback;
}

/**
 * @param {unknown} body
 * @returns {{ ok: true, data: object } | { ok: false, error: string }}
 */
export function parseQrArCardBody(body) {
    const cardId = String(body?.cardId ?? body?.card_id ?? '').trim();
    const label = String(body?.label ?? '').trim();
    if (!isValidCardIdFormat(cardId)) {
        return { ok: false, error: 'invalid_card_id' };
    }
    if (!label || label.length > LABEL_MAX_LEN) {
        return { ok: false, error: 'invalid_label' };
    }
    const enabledRaw = body?.enabled;
    const enabled =
        enabledRaw === undefined || enabledRaw === null
            ? 1
            : enabledRaw === true || enabledRaw === 1 || enabledRaw === '1'
              ? 1
              : 0;
    const qrSize = parseFiniteNumber(body?.qrPhysicalSizeM ?? body?.qr_physical_size_m, 0.02);
    if (qrSize <= 0 || qrSize > 1) {
        return { ok: false, error: 'invalid_qr_physical_size' };
    }
    return {
        ok: true,
        data: {
            cardId,
            label,
            modelScale: parseFiniteNumber(body?.modelScale ?? body?.model_scale, 1),
            offsetX: parseFiniteNumber(body?.offsetX ?? body?.offset_x, 0),
            offsetY: parseFiniteNumber(body?.offsetY ?? body?.offset_y, 0.05),
            offsetZ: parseFiniteNumber(body?.offsetZ ?? body?.offset_z, 0),
            qrPhysicalSizeM: qrSize,
            enabled,
        },
    };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {object} data
 */
export function createQrArCard(db, data) {
    const stmt = db.prepare(
        `INSERT INTO qr_ar_cards (
            card_id, label, model_scale, offset_x, offset_y, offset_z, qr_physical_size_m, enabled
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const info = stmt.run(
        data.cardId,
        data.label,
        data.modelScale,
        data.offsetX,
        data.offsetY,
        data.offsetZ,
        data.qrPhysicalSizeM,
        data.enabled
    );
    return getQrArCardById(db, Number(info.lastInsertRowid));
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {number} id
 * @param {object} data
 */
export function updateQrArCard(db, id, data) {
    db.prepare(
        `UPDATE qr_ar_cards SET
            label = ?,
            model_scale = ?,
            offset_x = ?,
            offset_y = ?,
            offset_z = ?,
            qr_physical_size_m = ?,
            enabled = ?,
            updated_at = datetime('now')
        WHERE id = ?`
    ).run(
        data.label,
        data.modelScale,
        data.offsetX,
        data.offsetY,
        data.offsetZ,
        data.qrPhysicalSizeM,
        data.enabled,
        id
    );
    return getQrArCardById(db, id);
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {number} id
 * @param {string} modelFilename
 */
export function setQrArCardModelFilename(db, id, modelFilename) {
    db.prepare(
        `UPDATE qr_ar_cards SET model_filename = ?, updated_at = datetime('now') WHERE id = ?`
    ).run(modelFilename, id);
    return getQrArCardById(db, id);
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {number} id
 */
export function deleteQrArCard(db, id) {
    const row = getQrArCardById(db, id);
    if (!row) return null;
    db.prepare('DELETE FROM qr_ar_cards WHERE id = ?').run(id);
    return row;
}
