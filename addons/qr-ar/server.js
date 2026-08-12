// addons/qr-ar/server.js — QR-AR カード HTTP API（公開 + 管理）
import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import multer from 'multer';
import QRCode from 'qrcode';
import rateLimit from 'express-rate-limit';
import { STORAGE_PATHS } from '../../config/storage-paths.js';
import { HOOKS } from '../../lib/hook-registry.js';
import { MODEL_UPLOAD_MAX_BYTES } from '../../lib/model-upload-max-bytes.js';
import {
    runGlbTextureResizeQueued,
    parseTextureMaxEdgeFromUploadBody,
} from '../../lib/glb-texture-resize.js';
import {
    createQrArCard,
    deleteQrArCard,
    getQrArCardByCardId,
    getQrArCardById,
    isValidCardIdFormat,
    listQrArCards,
    parseQrArCardBody,
    serializeQrArCard,
    setQrArCardModelFilename,
    updateQrArCard,
} from './lib/db.js';

const JSON_BODY_LIMIT = '32kb';
const CARD_ID_RE = /^\d+$/;
const MODEL_FILENAME_RE = /^[A-Za-z0-9_.-]+\.glb$/;

const cardResolveLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 120,
    standardHeaders: true,
    legacyHeaders: false,
    message: { ok: false, error: 'rate_limited' },
});

const uploadStorage = multer.memoryStorage();
const uploadGlb = multer({
    storage: uploadStorage,
    limits: { fileSize: MODEL_UPLOAD_MAX_BYTES },
    fileFilter: (_req, file, cb) => {
        const ext = path.extname(file.originalname || '').toLowerCase();
        cb(null, ext === '.glb');
    },
});

/**
 * @param {string} cardId
 * @returns {string}
 */
function modelFilenameForCardId(cardId) {
    return `${cardId}.glb`;
}

/**
 * @param {string} cardId
 * @returns {string}
 */
function modelAbsPathForCardId(cardId) {
    return path.join(STORAGE_PATHS.QR_AR_MODELS_DIR, modelFilenameForCardId(cardId));
}

/**
 * @param {string} cardId
 * @returns {string}
 */
function buildPublicModelUrl(cardId) {
    return `/api/addons/qr-ar/models/${encodeURIComponent(modelFilenameForCardId(cardId))}`;
}

/**
 * @param {object} row
 */
function rowWithModelUrl(row) {
    const cardId = String(row.card_id);
    const url = row.model_filename ? buildPublicModelUrl(cardId) : null;
    return serializeQrArCard(row, url);
}

export default {
    /**
     * @param {object} ctx plugin context
     */
    async register(ctx) {
        ctx.openDatabase();

        if (!fs.existsSync(STORAGE_PATHS.QR_AR_MODELS_DIR)) {
            fs.mkdirSync(STORAGE_PATHS.QR_AR_MODELS_DIR, { recursive: true });
        }

        const jsonMw = express.json({ limit: JSON_BODY_LIMIT });

        ctx.hooks.on(HOOKS.EXPRESS_SETUP, ({ app }) => {
            app.get(`${ctx.paths.httpBasePath}/cards/:cardId`, cardResolveLimiter, (req, res) => {
                const cardId = String(req.params.cardId || '').trim();
                if (!isValidCardIdFormat(cardId)) {
                    return res.status(400).json({ ok: false, error: 'invalid_card_id' });
                }
                try {
                    const db = ctx.openDatabase();
                    const row = getQrArCardByCardId(db, cardId);
                    if (!row || row.enabled !== 1) {
                        return res.status(404).json({ ok: false, error: 'not_found' });
                    }
                    if (!row.model_filename) {
                        return res.status(404).json({ ok: false, error: 'no_model' });
                    }
                    const abs = modelAbsPathForCardId(cardId);
                    if (!fs.existsSync(abs)) {
                        return res.status(404).json({ ok: false, error: 'model_missing' });
                    }
                    res.json({
                        ok: true,
                        card: rowWithModelUrl(row),
                    });
                } catch (e) {
                    ctx.logger.error('GET qr-ar card', e);
                    res.status(500).json({ ok: false, error: 'resolve_failed' });
                }
            });

            app.get(`${ctx.paths.httpBasePath}/models/:filename`, cardResolveLimiter, (req, res) => {
                const filename = String(req.params.filename || '');
                if (!MODEL_FILENAME_RE.test(filename)) {
                    return res.status(400).json({ ok: false, error: 'invalid_filename' });
                }
                const abs = path.resolve(path.join(STORAGE_PATHS.QR_AR_MODELS_DIR, filename));
                const base = path.resolve(STORAGE_PATHS.QR_AR_MODELS_DIR);
                if (abs !== base && !abs.startsWith(base + path.sep)) {
                    return res.status(403).json({ ok: false, error: 'forbidden' });
                }
                if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
                    return res.status(404).json({ ok: false, error: 'not_found' });
                }
                res.type('model/gltf-binary');
                res.setHeader('Cache-Control', 'public, max-age=3600');
                res.sendFile(abs);
            });

            app.get('/admin/addons/qr-ar/cards', (req, res) => {
                try {
                    const db = ctx.openDatabase();
                    const rows = listQrArCards(db);
                    res.json({
                        ok: true,
                        cards: rows.map((row) => rowWithModelUrl(row)),
                    });
                } catch (e) {
                    ctx.logger.error('GET admin qr-ar cards', e);
                    res.status(500).json({ ok: false, error: 'list_failed' });
                }
            });

            app.post('/admin/addons/qr-ar/cards', jsonMw, (req, res) => {
                const parsed = parseQrArCardBody(req.body);
                if (!parsed.ok) {
                    return res.status(400).json({ ok: false, error: parsed.error });
                }
                try {
                    const db = ctx.openDatabase();
                    const existing = getQrArCardByCardId(db, parsed.data.cardId);
                    if (existing) {
                        return res.status(409).json({ ok: false, error: 'card_id_exists' });
                    }
                    const row = createQrArCard(db, parsed.data);
                    res.status(201).json({ ok: true, card: rowWithModelUrl(row) });
                } catch (e) {
                    ctx.logger.error('POST admin qr-ar card', e);
                    res.status(500).json({ ok: false, error: 'create_failed' });
                }
            });

            app.put('/admin/addons/qr-ar/cards/:id', jsonMw, (req, res) => {
                const idRaw = String(req.params.id || '');
                if (!CARD_ID_RE.test(idRaw)) {
                    return res.status(400).json({ ok: false, error: 'invalid_id' });
                }
                const id = Number(idRaw);
                try {
                    const db = ctx.openDatabase();
                    const existing = getQrArCardById(db, id);
                    if (!existing) {
                        return res.status(404).json({ ok: false, error: 'not_found' });
                    }
                    const parsed = parseQrArCardBody({
                        ...req.body,
                        cardId: existing.card_id,
                    });
                    if (!parsed.ok) {
                        return res.status(400).json({ ok: false, error: parsed.error });
                    }
                    const row = updateQrArCard(db, id, parsed.data);
                    res.json({ ok: true, card: rowWithModelUrl(row) });
                } catch (e) {
                    ctx.logger.error('PUT admin qr-ar card', e);
                    res.status(500).json({ ok: false, error: 'update_failed' });
                }
            });

            app.delete('/admin/addons/qr-ar/cards/:id', (req, res) => {
                const idRaw = String(req.params.id || '');
                if (!CARD_ID_RE.test(idRaw)) {
                    return res.status(400).json({ ok: false, error: 'invalid_id' });
                }
                const id = Number(idRaw);
                try {
                    const db = ctx.openDatabase();
                    const row = deleteQrArCard(db, id);
                    if (!row) {
                        return res.status(404).json({ ok: false, error: 'not_found' });
                    }
                    const abs = modelAbsPathForCardId(String(row.card_id));
                    if (fs.existsSync(abs)) {
                        try {
                            fs.unlinkSync(abs);
                        } catch (e) {
                            ctx.logger.warn('delete qr-ar model file', e);
                        }
                    }
                    res.json({ ok: true });
                } catch (e) {
                    ctx.logger.error('DELETE admin qr-ar card', e);
                    res.status(500).json({ ok: false, error: 'delete_failed' });
                }
            });

            app.post(
                '/admin/addons/qr-ar/cards/:id/model',
                uploadGlb.single('model'),
                async (req, res) => {
                    const idRaw = String(req.params.id || '');
                    if (!CARD_ID_RE.test(idRaw)) {
                        return res.status(400).json({ ok: false, error: 'invalid_id' });
                    }
                    if (!req.file) {
                        return res.status(400).json({ ok: false, error: 'no_file' });
                    }
                    const id = Number(idRaw);
                    try {
                        const db = ctx.openDatabase();
                        const row = getQrArCardById(db, id);
                        if (!row) {
                            return res.status(404).json({ ok: false, error: 'not_found' });
                        }
                        const cardId = String(row.card_id);
                        const destPath = modelAbsPathForCardId(cardId);
                        const textureParsed = parseTextureMaxEdgeFromUploadBody(req.body?.textureMaxEdge);
                        if (!textureParsed.ok) {
                            return res.status(400).json({ ok: false, error: textureParsed.error });
                        }
                        const { buffer, textureResize } = await runGlbTextureResizeQueued(req.file.buffer, {
                            maxEdgePx: textureParsed.value,
                        });
                        fs.writeFileSync(destPath, buffer);
                        const filename = modelFilenameForCardId(cardId);
                        const updated = setQrArCardModelFilename(db, id, filename);
                        res.json({
                            ok: true,
                            card: rowWithModelUrl(updated),
                            textureResize,
                        });
                    } catch (e) {
                        ctx.logger.error('POST admin qr-ar model', e);
                        res.status(500).json({ ok: false, error: 'upload_failed' });
                    }
                }
            );

            app.get('/admin/addons/qr-ar/cards/:id/qr-preview', async (req, res) => {
                const idRaw = String(req.params.id || '');
                if (!CARD_ID_RE.test(idRaw)) {
                    return res.status(400).json({ ok: false, error: 'invalid_id' });
                }
                const id = Number(idRaw);
                try {
                    const db = ctx.openDatabase();
                    const row = getQrArCardById(db, id);
                    if (!row) {
                        return res.status(404).json({ ok: false, error: 'not_found' });
                    }
                    const png = await QRCode.toBuffer(String(row.card_id), {
                        type: 'png',
                        width: 320,
                        margin: 2,
                        errorCorrectionLevel: 'M',
                    });
                    res.type('image/png');
                    res.setHeader('Cache-Control', 'no-store');
                    res.send(png);
                } catch (e) {
                    ctx.logger.error('GET qr-ar qr-preview', e);
                    res.status(500).json({ ok: false, error: 'qr_preview_failed' });
                }
            });
        });

        ctx.logger.info('registered');
    },
};
