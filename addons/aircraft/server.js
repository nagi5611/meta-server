// addons/aircraft/server.js — Socket + 機体ライブラリ HTTP API（SQLite）
import express from 'express';
import { HOOKS } from '../../lib/hook-registry.js';
import { registerAircraftSocketHandlers } from '../../lib/aircraft-server/register-socket.js';
import { mergeAircraftPhysicsFromWorld } from '../../addons/aircraft/client/aircraft-physics-defaults.js';
import {
    mergeEasyAircraftPhysicsFromWorld,
    normalizeAircraftControlMode,
} from '../../addons/aircraft/client/aircraft-physics-easy-defaults.js';
import {
    appendAircraftPhysicsValidationErrors,
    appendEasyAircraftPhysicsValidationErrors,
} from '../../lib/aircraft-server/validate-worlds.js';

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
 * @param {unknown} raw
 * @param {'hard'|'easy'} kind
 * @returns {{ ok: true, obj: Record<string, number> } | { ok: false, error: string }}
 */
function parseFlightPhysics(raw, kind = 'hard') {
    const label = kind === 'easy' ? 'flightPhysicsEasy' : 'flightPhysicsHard';
    if (raw == null) {
        return {
            ok: true,
            obj:
                kind === 'easy'
                    ? mergeEasyAircraftPhysicsFromWorld(null)
                    : mergeAircraftPhysicsFromWorld(null),
        };
    }
    if (!isPlainObject(raw)) return { ok: false, error: `${label} must be an object` };
    const merged =
        kind === 'easy' ? mergeEasyAircraftPhysicsFromWorld(raw) : mergeAircraftPhysicsFromWorld(raw);
    const errs = [];
    if (kind === 'easy') {
        appendEasyAircraftPhysicsValidationErrors(merged, label, errs);
    } else {
        appendAircraftPhysicsValidationErrors(merged, label, errs);
    }
    if (errs.length) return { ok: false, error: errs[0] };
    const s = JSON.stringify(merged);
    if (s.length > 32000) return { ok: false, error: `${label} JSON too large` };
    return { ok: true, obj: merged };
}

/**
 * @param {unknown} raw
 * @returns {{ ok: true, obj: Record<string, unknown> } | { ok: false, error: string }}
 */
function parseCameraJson(raw) {
    if (raw == null) return { ok: true, obj: {} };
    if (!isPlainObject(raw)) return { ok: false, error: 'camera must be an object' };
    const out = {};
    const vec3 = (v, def) => {
        if (!isPlainObject(v)) return { ...def };
        const x = typeof v.x === 'number' && Number.isFinite(v.x) ? v.x : def.x;
        const y = typeof v.y === 'number' && Number.isFinite(v.y) ? v.y : def.y;
        const z = typeof v.z === 'number' && Number.isFinite(v.z) ? v.z : def.z;
        return { x, y, z };
    };
    const euler = (v) => {
        if (!isPlainObject(v)) return undefined;
        const x = typeof v.x === 'number' && Number.isFinite(v.x) ? v.x : 0;
        const y = typeof v.y === 'number' && Number.isFinite(v.y) ? v.y : 0;
        const z = typeof v.z === 'number' && Number.isFinite(v.z) ? v.z : 0;
        return { x, y, z };
    };
    if (raw.cockpitOffset) out.cockpitOffset = vec3(raw.cockpitOffset, { x: 0, y: 1.2, z: 0 });
    if (raw.chaseOffset) out.chaseOffset = vec3(raw.chaseOffset, { x: 0, y: 3, z: 12 });
    const ce = euler(raw.cockpitEulerDeg);
    if (ce) out.cockpitEulerDeg = ce;
    const se = euler(raw.chaseEulerDeg);
    if (se) out.chaseEulerDeg = se;
    if (raw.meshVisualEulerDeg != null && isPlainObject(raw.meshVisualEulerDeg)) {
        const me = euler(raw.meshVisualEulerDeg);
        if (me) out.meshVisualEulerDeg = me;
    }
    const VP_ID_RE = /^[a-zA-Z0-9_-]{1,48}$/;
    if (Array.isArray(raw.viewpoints)) {
        /** @type {unknown[]} */
        const vps = [];
        for (const item of raw.viewpoints) {
            if (!isPlainObject(item)) continue;
            const id = typeof item.id === 'string' ? item.id.trim() : '';
            if (!VP_ID_RE.test(id)) continue;
            const roleRaw = typeof item.role === 'string' ? item.role.trim().toLowerCase() : 'free';
            const role = roleRaw === 'cockpit' || roleRaw === 'chase' ? roleRaw : 'free';
            const name =
                typeof item.name === 'string' && item.name.trim() ? item.name.trim().slice(0, 64) : id;
            vps.push({
                id,
                name,
                role,
                position: vec3(item.position, { x: 0, y: 1.2, z: 0 }),
                eulerDeg: euler(item.eulerDeg) || { x: 0, y: 0, z: 0 },
            });
        }
        if (vps.length) out.viewpoints = vps;
    }
    const s = JSON.stringify(out);
    if (s.length > 16000) return { ok: false, error: 'camera JSON too large' };
    return { ok: true, obj: out };
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
    let flightPhysicsHardRaw = {};
    let flightPhysicsEasyRaw = {};
    let cameraHardRaw = {};
    let cameraEasyRaw = {};
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
    try {
        flightPhysicsHardRaw = row.physics_json ? JSON.parse(String(row.physics_json)) : {};
    } catch {
        flightPhysicsHardRaw = {};
    }
    try {
        flightPhysicsEasyRaw = row.physics_easy_json ? JSON.parse(String(row.physics_easy_json)) : {};
    } catch {
        flightPhysicsEasyRaw = {};
    }
    try {
        cameraHardRaw = row.camera_json ? JSON.parse(String(row.camera_json)) : {};
    } catch {
        cameraHardRaw = {};
    }
    try {
        cameraEasyRaw = row.camera_easy_json ? JSON.parse(String(row.camera_easy_json)) : {};
    } catch {
        cameraEasyRaw = {};
    }
    const controlMode = normalizeAircraftControlMode(row.control_mode);
    const fpHard = parseFlightPhysics(flightPhysicsHardRaw, 'hard');
    const fpEasy = parseFlightPhysics(flightPhysicsEasyRaw, 'easy');
    const camHard = parseCameraJson(cameraHardRaw);
    const camEasy = parseCameraJson(cameraEasyRaw);
    const flightPhysicsHard = fpHard.ok ? fpHard.obj : mergeAircraftPhysicsFromWorld(null);
    const flightPhysicsEasy = fpEasy.ok ? fpEasy.obj : mergeEasyAircraftPhysicsFromWorld(null);
    const cameraHard = camHard.ok && isPlainObject(camHard.obj) ? camHard.obj : {};
    const cameraEasy = camEasy.ok && isPlainObject(camEasy.obj) ? camEasy.obj : {};
    const activePhysics = controlMode === 'easy' ? flightPhysicsEasy : flightPhysicsHard;
    const activeCamera = controlMode === 'easy' ? cameraEasy : cameraHard;
    return {
        id: String(row.id),
        displayName: String(row.display_name || ''),
        prefabManifest: String(row.prefab_manifest || ''),
        controlMode,
        bindings: isPlainObject(bindings) ? bindings : {},
        animation: isPlainObject(animation) ? animation : {},
        flightPhysicsHard,
        flightPhysicsEasy,
        cameraHard,
        cameraEasy,
        flightPhysics: activePhysics,
        camera: activeCamera,
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
                            'SELECT id, display_name, prefab_manifest, control_mode, updated_at FROM aircraft_airframe ORDER BY id ASC'
                        )
                        .all();
                    res.json({
                        ok: true,
                        airframes: rows.map((r) => ({
                            id: String(r.id),
                            displayName: String(r.display_name || ''),
                            prefabManifest: String(r.prefab_manifest || ''),
                            controlMode: normalizeAircraftControlMode(r.control_mode),
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
                    const controlMode = normalizeAircraftControlMode(body.controlMode);
                    const fpHardRaw =
                        body.flightPhysicsHard != null ? body.flightPhysicsHard : body.flightPhysics;
                    const fpEasyRaw = body.flightPhysicsEasy;
                    const camHardRaw = body.cameraHard != null ? body.cameraHard : body.camera;
                    const camEasyRaw = body.cameraEasy;
                    const fpHard = parseFlightPhysics(fpHardRaw, 'hard');
                    if (!fpHard.ok) return res.status(400).json({ error: fpHard.error });
                    const fpEasy = parseFlightPhysics(fpEasyRaw, 'easy');
                    if (!fpEasy.ok) return res.status(400).json({ error: fpEasy.error });
                    const camHard = parseCameraJson(camHardRaw);
                    if (!camHard.ok) return res.status(400).json({ error: camHard.error });
                    const camEasy = parseCameraJson(camEasyRaw);
                    if (!camEasy.ok) return res.status(400).json({ error: camEasy.error });

                    const exists = db.prepare('SELECT 1 FROM aircraft_airframe WHERE id = ?').get(id);
                    if (exists) {
                        db.prepare(
                            `UPDATE aircraft_airframe SET
                                display_name = ?,
                                prefab_manifest = ?,
                                bindings_json = ?,
                                animation_json = ?,
                                physics_json = ?,
                                camera_json = ?,
                                control_mode = ?,
                                physics_easy_json = ?,
                                camera_easy_json = ?,
                                updated_at = datetime('now')
                             WHERE id = ?`
                        ).run(
                            displayName,
                            prefabManifest,
                            JSON.stringify(b.obj),
                            JSON.stringify(a.obj),
                            JSON.stringify(fpHard.obj),
                            JSON.stringify(camHard.obj),
                            controlMode,
                            JSON.stringify(fpEasy.obj),
                            JSON.stringify(camEasy.obj),
                            id
                        );
                    } else {
                        db.prepare(
                            `INSERT INTO aircraft_airframe (id, display_name, prefab_manifest, bindings_json, animation_json, physics_json, camera_json, control_mode, physics_easy_json, camera_easy_json, updated_at)
                             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
                        ).run(
                            id,
                            displayName,
                            prefabManifest,
                            JSON.stringify(b.obj),
                            JSON.stringify(a.obj),
                            JSON.stringify(fpHard.obj),
                            JSON.stringify(camHard.obj),
                            controlMode,
                            JSON.stringify(fpEasy.obj),
                            JSON.stringify(camEasy.obj)
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

            /**
             * prefab マニフェストパスが一致する機体ライブラリ ID を返す（ワールド編集で aircraftLibraryId なし配置向け）
             */
            app.get('/api/addons/aircraft/lookup-airframe-id-by-prefab-manifest', (req, res) => {
                try {
                    const man =
                        typeof req.query.prefabManifest === 'string'
                            ? req.query.prefabManifest.trim().slice(0, 1024)
                            : '';
                    if (!man) {
                        return res.status(400).json({ error: 'missing_prefab_manifest' });
                    }
                    const db = ctx.openDatabase();
                    const row = db
                        .prepare(
                            'SELECT id FROM aircraft_airframe WHERE prefab_manifest = ? ORDER BY id ASC LIMIT 1'
                        )
                        .get(man);
                    if (!row) return res.status(404).json({ error: 'not_found' });
                    res.setHeader('Cache-Control', 'public, max-age=60');
                    res.json({ ok: true, airframeId: String(row.id) });
                } catch (e) {
                    ctx.logger.error('GET lookup airframe by prefab manifest', e);
                    res.status(500).json({ error: 'lookup_failed' });
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
