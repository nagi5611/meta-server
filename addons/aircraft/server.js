// addons/aircraft/server.js — Socket + 機体ライブラリ HTTP API（SQLite）
import express from 'express';
import { HOOKS } from '../../lib/hook-registry.js';
import { registerAircraftSocketHandlers } from '../../lib/aircraft-server/register-socket.js';

const AIRFRAME_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;
const JSON_BODY_LIMIT = 512 * 1024;

/**
 * @param {unknown} v
 * @returns {v is Record<string, unknown>}
 */
function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

const BINDINGS_MAX_PATH_LEN = 2048;
const BINDINGS_MAX_PATHS_PER_ROLE = 64;

/**
 * @param {unknown} raw
 * @returns {{ ok: true, obj: Record<string, string[]> } | { ok: false, error: string }}
 */
function parseBindings(raw) {
    if (raw == null) return { ok: true, obj: {} };
    if (!isPlainObject(raw)) return { ok: false, error: 'bindings must be an object' };
    /** @type {Record<string, string[]>} */
    const out = {};
    for (const [k, v] of Object.entries(raw)) {
        if (typeof k !== 'string' || !k.trim()) continue;
        const key = k.trim();
        /** @type {string[]} */
        const paths = [];
        if (Array.isArray(v)) {
            for (const item of v) {
                if (typeof item !== 'string') {
                    return { ok: false, error: `bindings.${key} must be an array of strings` };
                }
                const p = item.trim();
                if (!p) continue;
                if (p.length > BINDINGS_MAX_PATH_LEN) {
                    return { ok: false, error: `bindings.${key} path too long` };
                }
                if (!paths.includes(p)) paths.push(p);
                if (paths.length > BINDINGS_MAX_PATHS_PER_ROLE) {
                    return { ok: false, error: `bindings.${key} too many paths` };
                }
            }
        } else if (typeof v === 'string') {
            const p = v.trim();
            if (p) {
                if (p.length > BINDINGS_MAX_PATH_LEN) {
                    return { ok: false, error: `bindings.${key} path too long` };
                }
                paths.push(p);
            }
        } else {
            return { ok: false, error: `bindings.${key} must be a string or string[]` };
        }
        if (paths.length) out[key] = paths;
    }
    return { ok: true, obj: out };
}

/**
 * @param {unknown} raw
 * @returns {{ ok: true, obj: Record<string, unknown> } | { ok: false, error: string }}
 */
function parseAnimation(raw) {
    if (raw == null) return { ok: true, obj: {} };
    if (!isPlainObject(raw)) return { ok: false, error: 'animation must be an object' };
    const s = JSON.stringify(raw);
    if (s.length > 32000) return { ok: false, error: 'animation JSON too large' };
    return { ok: true, obj: raw };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} id
 * @returns {object|null}
 */
function rowToAirframe(db, id) {
    const row = db.prepare('SELECT * FROM aircraft_airframe WHERE id = ?').get(id);
    if (!row) return null;
    let bindings = {};
    let animation = {};
    try {
        bindings = row.bindings_json ? JSON.parse(String(row.bindings_json)) : {};
    } catch {
        bindings = {};
    }
    try {
        animation = row.animation_json ? JSON.parse(String(row.animation_json)) : {};
    } catch {
        animation = {};
    }
    return {
        id: String(row.id),
        displayName: String(row.display_name || ''),
        prefabManifest: String(row.prefab_manifest || ''),
        bindings: isPlainObject(bindings) ? bindings : {},
        animation: isPlainObject(animation) ? animation : {},
        updatedAt: String(row.updated_at || ''),
    };
}

export default {
    /**
     * @param {object} ctx — アドオン登録コンテキスト
     */
    async register(ctx) {
        ctx.openDatabase();

        ctx.hooks.on(HOOKS.SOCKET_SETUP, ({ io }) => {
            registerAircraftSocketHandlers(io);
        });

        ctx.hooks.on(HOOKS.EXPRESS_SETUP, ({ app }) => {
            const jsonMw = express.json({ limit: JSON_BODY_LIMIT });

            /**
             * @param {import('express').Request} req
             * @param {import('express').Response} res
             * @param {import('express').NextFunction} next
             */
            const airframeIdParam = (req, res, next) => {
                const id = String(req.params?.id || '').trim();
                if (!AIRFRAME_ID_RE.test(id)) {
                    return res.status(400).json({ error: 'invalid_airframe_id' });
                }
                res.locals.airframeId = id;
                next();
            };

            app.get('/admin/addons/aircraft/airframes', (_req, res) => {
                try {
                    const db = ctx.openDatabase();
                    const rows = db
                        .prepare(
                            'SELECT id, display_name, prefab_manifest, updated_at FROM aircraft_airframe ORDER BY id ASC'
                        )
                        .all();
                    res.json({
                        ok: true,
                        airframes: rows.map((r) => ({
                            id: String(r.id),
                            displayName: String(r.display_name || ''),
                            prefabManifest: String(r.prefab_manifest || ''),
                            updatedAt: String(r.updated_at || ''),
                        })),
                    });
                } catch (e) {
                    ctx.logger.error('GET airframes list', e);
                    res.status(500).json({ error: 'list_failed' });
                }
            });

            app.get('/admin/addons/aircraft/airframes/:id', airframeIdParam, (req, res) => {
                try {
                    const db = ctx.openDatabase();
                    const row = rowToAirframe(db, res.locals.airframeId);
                    if (!row) return res.status(404).json({ error: 'not_found' });
                    res.json({ ok: true, airframe: row });
                } catch (e) {
                    ctx.logger.error('GET airframe', e);
                    res.status(500).json({ error: 'get_failed' });
                }
            });

            app.put('/admin/addons/aircraft/airframes/:id', airframeIdParam, jsonMw, (req, res) => {
                try {
                    const db = ctx.openDatabase();
                    const id = res.locals.airframeId;
                    const body = req.body && typeof req.body === 'object' ? req.body : {};
                    const displayName =
                        typeof body.displayName === 'string' ? body.displayName.trim().slice(0, 200) : '';
                    const prefabManifest =
                        typeof body.prefabManifest === 'string'
                            ? body.prefabManifest.trim().slice(0, 1024)
                            : '';
                    const b = parseBindings(body.bindings);
                    if (!b.ok) return res.status(400).json({ error: b.error });
                    const a = parseAnimation(body.animation);
                    if (!a.ok) return res.status(400).json({ error: a.error });

                    const exists = db.prepare('SELECT 1 FROM aircraft_airframe WHERE id = ?').get(id);
                    if (exists) {
                        db.prepare(
                            `UPDATE aircraft_airframe SET
                                display_name = ?,
                                prefab_manifest = ?,
                                bindings_json = ?,
                                animation_json = ?,
                                updated_at = datetime('now')
                             WHERE id = ?`
                        ).run(
                            displayName,
                            prefabManifest,
                            JSON.stringify(b.obj),
                            JSON.stringify(a.obj),
                            id
                        );
                    } else {
                        db.prepare(
                            `INSERT INTO aircraft_airframe (id, display_name, prefab_manifest, bindings_json, animation_json, updated_at)
                             VALUES (?, ?, ?, ?, ?, datetime('now'))`
                        ).run(
                            id,
                            displayName,
                            prefabManifest,
                            JSON.stringify(b.obj),
                            JSON.stringify(a.obj)
                        );
                    }
                    const row = rowToAirframe(db, id);
                    res.json({ ok: true, airframe: row });
                } catch (e) {
                    ctx.logger.error('PUT airframe', e);
                    res.status(500).json({ error: 'save_failed' });
                }
            });

            app.delete('/admin/addons/aircraft/airframes/:id', airframeIdParam, (req, res) => {
                try {
                    const db = ctx.openDatabase();
                    const r = db.prepare('DELETE FROM aircraft_airframe WHERE id = ?').run(res.locals.airframeId);
                    if (r.changes === 0) return res.status(404).json({ error: 'not_found' });
                    res.json({ ok: true });
                } catch (e) {
                    ctx.logger.error('DELETE airframe', e);
                    res.status(500).json({ error: 'delete_failed' });
                }
            });

            /** ゲームクライアント用（認証なし・定義のみ） */
            app.get('/api/addons/aircraft/airframes/:id', airframeIdParam, (req, res) => {
                try {
                    const db = ctx.openDatabase();
                    const row = rowToAirframe(db, res.locals.airframeId);
                    if (!row) return res.status(404).json({ error: 'not_found' });
                    res.setHeader('Cache-Control', 'public, max-age=60');
                    res.json({ ok: true, airframe: row });
                } catch (e) {
                    ctx.logger.error('GET public airframe', e);
                    res.status(500).json({ error: 'get_failed' });
                }
            });
        });

        ctx.logger.info('registered');
    },
};
