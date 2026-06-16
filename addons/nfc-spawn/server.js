// addons/nfc-spawn/server.js — NFC スポーン HTTP API（公開 + 管理）
import express from 'express';
import rateLimit from 'express-rate-limit';
import { HOOKS } from '../../lib/hook-registry.js';
import { isValidWorldId } from './lib/worlds.js';
import {
    createNfcSpawn,
    deleteNfcSpawn,
    getNfcSpawnById,
    isValidSpawnTokenFormat,
    listNfcSpawns,
    parseSpawnBody,
    regenerateSpawnToken,
    resolveSpawnByToken,
    serializeSpawnRow,
    updateNfcSpawn,
} from './lib/db.js';

const JSON_BODY_LIMIT = '32kb';
const SPAWN_ID_RE = /^\d+$/;

const spawnResolveLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    message: { ok: false, error: 'rate_limited' },
});

/**
 * リクエストから公開 URL のオリジンを組み立てる
 * @param {import('express').Request} req
 * @param {Record<string, unknown>} config
 * @returns {string}
 */
function getPublicOrigin(req, config) {
    const fromConfig =
        typeof config.publicBaseUrl === 'string' ? config.publicBaseUrl.trim().replace(/\/$/, '') : '';
    if (fromConfig) return fromConfig;
    const proto = req.get('x-forwarded-proto') || req.protocol || 'https';
    const host = req.get('x-forwarded-host') || req.get('host') || 'localhost';
    return `${proto}://${host}`;
}

/**
 * @param {import('express').Request} req
 * @param {Record<string, unknown>} config
 * @param {string} token
 * @returns {string}
 */
function buildSpawnUrl(req, config, token) {
    return `${getPublicOrigin(req, config)}/?spawn=${encodeURIComponent(token)}`;
}

/**
 * @param {import('express').Request} req
 * @param {Record<string, unknown>} config
 * @param {object} row
 */
function rowWithUrl(req, config, row) {
    return serializeSpawnRow(row, buildSpawnUrl(req, config, row.spawn_token));
}

export default {
    /**
     * @param {object} ctx
     */
    async register(ctx) {
        const jsonMw = express.json({ limit: JSON_BODY_LIMIT });

        ctx.hooks.on(HOOKS.EXPRESS_SETUP, ({ app }) => {
            app.get(`${ctx.paths.httpBasePath}/spawn/:token`, spawnResolveLimiter, (req, res) => {
                const token = String(req.params.token || '').trim();
                if (!isValidSpawnTokenFormat(token)) {
                    return res.status(400).json({ ok: false, error: 'invalid_token' });
                }
                try {
                    const db = ctx.openDatabase();
                    const resolved = resolveSpawnByToken(db, token);
                    if (!resolved) {
                        return res.status(404).json({ ok: false, error: 'not_found' });
                    }
                    if (!resolved.enabled) {
                        return res.status(403).json({ ok: false, error: 'disabled' });
                    }
                    if (!isValidWorldId(resolved.worldId)) {
                        return res.status(410).json({ ok: false, error: 'world_missing' });
                    }
                    res.setHeader('Cache-Control', 'private, no-store, max-age=0');
                    res.json({
                        ok: true,
                        world: resolved.worldId,
                        position: resolved.position,
                        yaw: resolved.yaw,
                        label: resolved.label,
                    });
                } catch (e) {
                    ctx.logger.error('GET spawn', e);
                    res.status(500).json({ ok: false, error: 'resolve_failed' });
                }
            });

            app.get('/admin/addons/nfc-spawn/spawns', (_req, res) => {
                try {
                    const db = ctx.openDatabase();
                    const rows = listNfcSpawns(db);
                    res.json({
                        ok: true,
                        spawns: rows.map((row) => rowWithUrl(_req, ctx.config, row)),
                    });
                } catch (e) {
                    ctx.logger.error('GET admin spawns', e);
                    res.status(500).json({ ok: false, error: 'list_failed' });
                }
            });

            app.post('/admin/addons/nfc-spawn/spawns', jsonMw, (req, res) => {
                const parsed = parseSpawnBody(req.body);
                if (!parsed.ok) {
                    return res.status(400).json({ ok: false, error: parsed.error });
                }
                if (!isValidWorldId(parsed.data.worldId)) {
                    return res.status(400).json({ ok: false, error: 'unknown_world' });
                }
                try {
                    const db = ctx.openDatabase();
                    const row = createNfcSpawn(db, parsed.data);
                    res.status(201).json({
                        ok: true,
                        spawn: rowWithUrl(req, ctx.config, row),
                    });
                } catch (e) {
                    ctx.logger.error('POST admin spawn', e);
                    res.status(500).json({ ok: false, error: 'create_failed' });
                }
            });

            app.put('/admin/addons/nfc-spawn/spawns/:id', jsonMw, (req, res) => {
                const idStr = String(req.params.id || '');
                if (!SPAWN_ID_RE.test(idStr)) {
                    return res.status(400).json({ ok: false, error: 'invalid_id' });
                }
                const id = Number(idStr);
                const parsed = parseSpawnBody(req.body);
                if (!parsed.ok) {
                    return res.status(400).json({ ok: false, error: parsed.error });
                }
                if (!isValidWorldId(parsed.data.worldId)) {
                    return res.status(400).json({ ok: false, error: 'unknown_world' });
                }
                try {
                    const db = ctx.openDatabase();
                    const existing = getNfcSpawnById(db, id);
                    if (!existing) {
                        return res.status(404).json({ ok: false, error: 'not_found' });
                    }
                    const row = updateNfcSpawn(db, id, parsed.data);
                    res.json({
                        ok: true,
                        spawn: rowWithUrl(req, ctx.config, row),
                    });
                } catch (e) {
                    ctx.logger.error('PUT admin spawn', e);
                    res.status(500).json({ ok: false, error: 'update_failed' });
                }
            });

            app.delete('/admin/addons/nfc-spawn/spawns/:id', (req, res) => {
                const idStr = String(req.params.id || '');
                if (!SPAWN_ID_RE.test(idStr)) {
                    return res.status(400).json({ ok: false, error: 'invalid_id' });
                }
                try {
                    const db = ctx.openDatabase();
                    const ok = deleteNfcSpawn(db, Number(idStr));
                    if (!ok) return res.status(404).json({ ok: false, error: 'not_found' });
                    res.json({ ok: true });
                } catch (e) {
                    ctx.logger.error('DELETE admin spawn', e);
                    res.status(500).json({ ok: false, error: 'delete_failed' });
                }
            });

            app.post('/admin/addons/nfc-spawn/spawns/:id/regenerate-token', (req, res) => {
                const idStr = String(req.params.id || '');
                if (!SPAWN_ID_RE.test(idStr)) {
                    return res.status(400).json({ ok: false, error: 'invalid_id' });
                }
                try {
                    const db = ctx.openDatabase();
                    const row = regenerateSpawnToken(db, Number(idStr));
                    if (!row) return res.status(404).json({ ok: false, error: 'not_found' });
                    res.json({
                        ok: true,
                        spawn: rowWithUrl(req, ctx.config, row),
                    });
                } catch (e) {
                    ctx.logger.error('POST regenerate-token', e);
                    res.status(500).json({ ok: false, error: 'regenerate_failed' });
                }
            });
        });

        ctx.logger.info('registered');
    },
};
