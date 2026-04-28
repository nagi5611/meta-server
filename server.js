import 'dotenv/config';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import express from 'express';
import http from 'http';
import https from 'https';
import { Server } from 'socket.io';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import multer from 'multer';
import os from 'os';
import * as mediasoup from 'mediasoup';
import { initDb, verifyStudent, verifyTeacher, registerStudent, registerTeacher, listStudents, listTeachers, updateStudent, updateTeacher, deleteStudent, deleteTeacher } from './db/users.js';
import { initUserSessionsDb, insertSession, getLatestSessionByUsername, getSessionsPaginated } from './db/user-sessions.js';
import { STORAGE_PATHS, validateAndPrepareStoragePaths } from './config/storage-paths.js';
import { MODEL_UPLOAD_MAX_BYTES } from './lib/model-upload-max-bytes.js';
import cookieParser from 'cookie-parser';
import { parse as parseCookieHeader } from 'cookie';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { signSocketAuthToken, verifySocketAuthToken, SOCKET_AUTH_TOKEN_MAX_AGE_MS } from './lib/socket-auth-token.js';
import {
    runGlbTextureResizeQueued,
    getModelUploadQueueStats,
    parseTextureMaxEdgeFromUploadBody,
} from './lib/glb-texture-resize.js';
import { runGlbObjectSplitFromBuffer, listObjectSplitFilesForBase } from './lib/glb-object-split.js';
import {
    applyPrefabBundleZipToModels,
    parseGlbOptionsFromPrefabBody,
    removePrefabBundleFromDisk,
    baseNameFromZipFilename,
} from './lib/prefab-bundle-upload.js';
import { ensureWavSidecarForMp3Path, runChartBgmWavMigration, wavPathForMp3 } from './lib/chart-bgm-transcode.js';
import { normalizeWorldsLod } from './public/js/world-lod-normalize.js';
import { USE_S3_MODELS, isS3ModelsConfigComplete, normalizedCdnBaseUrl } from './config/s3-assets.js';
import { insertVersionBeforeExt, createModelVersionToken } from './lib/model-upload-version.js';
import {
    uploadLocalModelsPathsOrRollbackS3,
    syncLocalModelsToS3OnStartup,
    uploadLocalModelsFile,
    canonicalCdnUrlForModelsRelative,
    tryUnlinkQuiet,
    publicAssetUrlCacheForModels,
} from './lib/s3-model-assets.js';
import { signCloudFrontGetUrl } from './lib/cloudfront-signed-urls.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Validate required storage env vars early (throw to fail-fast on startup)
validateAndPrepareStoragePaths();

const isNodeProduction = process.env.NODE_ENV === 'production';
/** httpOnly Cookie 名（Socket 認証用トークン） */
const SOCKET_AUTH_COOKIE_NAME = 'metaverse_socket_auth';

/** 本番: dist/index.html が存在し NODE_ENV=production のときは dist を配信 */
const isProductionBuild = process.env.NODE_ENV === 'production' &&
    fs.existsSync(path.join(__dirname, 'dist', 'index.html'));
const STATIC_DIR = path.join(__dirname, isProductionBuild ? 'dist' : 'public');

/**
 * ENABLE_CHART_FEATURES: 太鼓・譜面・譜面BGM・admin 譜面編集。未設定時は有効。0 / false / off / no で無効。
 * @param {string | undefined} raw
 * @returns {boolean}
 */
function parseEnvEnabledDefaultTrue(raw) {
    const s = String(raw ?? '').trim().toLowerCase();
    if (!s) return true;
    if (['0', 'false', 'off', 'no'].includes(s)) return false;
    return true;
}
const CHART_FEATURES_ENABLED = parseEnvEnabledDefaultTrue(process.env.ENABLE_CHART_FEATURES);

// Worlds config file (setting.html)
const WORLDS_PATH = STORAGE_PATHS.WORLDS_PATH;
/** 接続直後・change-world・admin-tp 後に Y クランプを抑止する時間（ms） */
const PHYSICS_ASSIST_GRACE_MS = Number(process.env.PHYSICS_ASSIST_GRACE_MS) || 3000;
/** Low ティア時の水平方向最大速度（m/s）。超過時は直前サーバ位置に戻す */
const PHYSICS_LOW_MAX_HORIZ_SPEED = Number(process.env.PHYSICS_LOW_MAX_HORIZ_SPEED) || 24;
/** クライアント physics-manager の capsuleInfo と一致させる */
const SERVER_CAPSULE_RADIUS = 0.5;
const SERVER_CAPSULE_HEIGHT = 1.0;
const DEFAULT_WORLDS = {
    'lobby': {
        id: 'lobby',
        name: 'Lobby',
        models: [
            { path: 'models/lobby.glb', position: { x: 0, y: 1, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 2, y: 2, z: 2 } },
            { path: 'models/monument.glb', position: { x: 0, y: 3.5, z: -10 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1.5, y: 1.5, z: 1.5 }, animate: { rotation: { x: 0, y: 0.1, z: 0 } } },
            { path: 'models/teleporter_s2.glb', position: { x: 6, y: 1.35, z: -10 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 0.05, y: 0.05, z: 0.05 }, animate: { rotation: { x: 0, y: 0.1, z: 0 } }, teleporter: { id: 's1', destinationWorld: 'school', radius: 3, label: '新校舎' } },
            { path: 'models/teleporter_l2.glb', position: { x: 6, y: 3.9, z: -10 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 0.3, y: 0.3, z: 0.3 } },
            {
                path: 'models/teleporter_l2.glb',
                position: { x: -18, y: 3, z: 18 },
                rotation: { x: 0, y: 135, z: 0 },
                scale: { x: 2.5, y: 2.5, z: 2.5 },
                aircraft: {
                    id: 'lobby-plane-1',
                    radius: 6,
                    label: '操縦する',
                    cockpitOffset: { x: 0, y: 1.2, z: 0 },
                    chaseOffset: { x: 0, y: 3, z: 12 }
                }
            }
        ],
        spawnPoint: { x: 0, y: 10, z: 0 },
        lights: [
            { type: 'ambient', intensity: 0.5, color: 0xffffff },
            { type: 'directional', position: { x: 50, y: 100, z: 50 }, intensity: 0.8, color: 0xffffff, castShadow: true },
            { type: 'point', position: { x: 6, y: 2, z: -10 }, intensity: 5, color: 0xffeedd, distance: 50 },
            { type: 'point', position: { x: 6, y: 4.5, z: -10 }, intensity: 5, color: 0xffeedd, distance: 50 }
        ]
    },
    'school': {
        id: 'school',
        name: '新校舎',
        models: [
            { path: 'models/school_base.glb', position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } }
        ],
        spawnPoint: { x: 0, y: 10, z: 0 },
        lights: [
            { type: 'ambient', intensity: 0.4, color: 0xffffff },
            { type: 'directional', position: { x: 30, y: 80, z: 20 }, intensity: 0.9, color: 0xffffcc, castShadow: true },
            { type: 'point', position: { x: 5, y: 5, z: 5 }, intensity: 0.6, color: 0xffffff, distance: 30 }
        ]
    }
};

/** メモリキャッシュ（writeWorlds で更新。外部が worlds.json を直接編集した場合は再起動が必要） */
let worldsRuntimeCache = null;

function ensureWorldsFile() {
    if (!fs.existsSync(WORLDS_PATH)) {
        fs.writeFileSync(WORLDS_PATH, JSON.stringify(DEFAULT_WORLDS, null, 2), 'utf8');
        console.log('Created worlds.json from default');
        worldsRuntimeCache = null;
    }
}

function readWorldsFromFile() {
    try {
        const data = fs.readFileSync(WORLDS_PATH, 'utf8');
        return JSON.parse(data);
    } catch (err) {
        console.warn('Failed to read worlds.json, using default:', err.message);
        return DEFAULT_WORLDS;
    }
}

function readWorlds() {
    if (worldsRuntimeCache == null) {
        worldsRuntimeCache = readWorldsFromFile();
    }
    return worldsRuntimeCache;
}

/** worlds.json（またはランタイムキャッシュ）に定義されたワールド ID か */
function isValidWorldRoomId(roomId) {
    const worlds = readWorlds();
    return worlds != null && typeof worlds === 'object' && Object.prototype.hasOwnProperty.call(worlds, roomId);
}

function writeWorlds(worlds) {
    const tmpPath = WORLDS_PATH + '.tmp.' + Date.now();
    fs.writeFileSync(tmpPath, JSON.stringify(worlds, null, 2), 'utf8');
    fs.renameSync(tmpPath, WORLDS_PATH);
    worldsRuntimeCache = JSON.parse(JSON.stringify(worlds));
}

/**
 * マルチプレイ太鼓の worlds 整合性検証（同一 groupId は1〜3台・譜面ID統一・必須項目）
 * @param {Record<string, unknown>} worlds
 * @returns {string[]} エラーメッセージ（空ならOK）
 */
function validateWorldsTaikoMultiplayer(worlds) {
    const errors = [];
    if (!worlds || typeof worlds !== 'object') return ['worlds が不正です'];
    for (const [wid, w] of Object.entries(worlds)) {
        if (!w || typeof w !== 'object' || !Array.isArray(w.models)) continue;
        /** @type {Map<string, { count: number, chartIds: Set<string> }>} */
        const groups = new Map();
        w.models.forEach((m, i) => {
            const t = m && m.taiko;
            if (!t || !t.multiplayer) return;
            const gid = String(t.groupId || '').trim();
            const cid = String(t.multiplayerChartId || '').trim();
            if (!gid) errors.push(`ワールド「${wid}」オブジェクト#${i + 1}: マルチ太鼓にはグループIDが必要です`);
            if (!cid) errors.push(`ワールド「${wid}」オブジェクト#${i + 1}: マルチ太鼓には譜面（曲）が必要です`);
            if (!groups.has(gid)) groups.set(gid, { count: 0, chartIds: new Set() });
            const g = groups.get(gid);
            g.count += 1;
            if (cid) g.chartIds.add(cid);
        });
        for (const [gid, g] of groups) {
            if (!gid) continue;
            if (g.count < 1 || g.count > 3) {
                errors.push(`ワールド「${wid}」グループ「${gid}」: マルチ太鼓は1〜3台にしてください（現在${g.count}台）`);
            }
            if (g.chartIds.size > 1) {
                errors.push(`ワールド「${wid}」グループ「${gid}」: 同じグループ内で譜面IDを統一してください`);
            }
        }
    }
    return errors;
}

/**
 * physicsAssist の min/max 整合性（POST /admin/worlds 用）
 * @param {Record<string, unknown>} worlds
 * @returns {string[]}
 */
function validateWorldsPhysicsAssist(worlds) {
    const errors = [];
    if (!worlds || typeof worlds !== 'object') return errors;
    for (const [wid, w] of Object.entries(worlds)) {
        if (!w || typeof w !== 'object') continue;
        const pa = w.physicsAssist;
        if (!pa || typeof pa !== 'object') continue;
        const min = pa.minFeetY;
        const max = pa.maxFeetY;
        const hasMin = typeof min === 'number' && Number.isFinite(min);
        const hasMax = typeof max === 'number' && Number.isFinite(max);
        if (hasMin && hasMax && min > max) {
            errors.push(`ワールド「${wid}」: physicsAssist の minFeetY は maxFeetY 以下にしてください`);
        }
    }
    return errors;
}

/** aircraftPhysics / models[].aircraft.aircraftPhysics の数値レンジ（POST /admin/worlds 用） */
const AIRCRAFT_PHYSICS_LIMITS = {
    maxSpeed: [1, 500],
    thrustAccel: [0.1, 200],
    drag: [0.5, 0.99999],
    yawAccel: [0.05, 40],
    yawAccelGround: [0.05, 40],
    yawAccelAir: [0.05, 40],
    pitchAccel: [0.05, 40],
    pitchAccelGround: [0.05, 40],
    pitchAccelAir: [0.05, 40],
    rollAccel: [0.05, 40],
    yawMaxRate: [0.02, 10],
    yawMaxRateGround: [0.02, 10],
    yawMaxRateAir: [0.02, 10],
    pitchMaxRate: [0.02, 10],
    pitchMaxRateGround: [0.02, 10],
    pitchMaxRateAir: [0.02, 10],
    rollMaxRate: [0.02, 10],
    angularDecel: [0, 30],
    yawGroundFrictionLeft: [0, 30],
    yawGroundFrictionRight: [0, 30],
    groundTireLateralDecel: [0, 500],
    groundTireRollingDecel: [0, 500],
    wheelBrakeDecel: [0.5, 200],
    gravity: [0, 50],
    liftPerHorizontalSpeed: [0, 5],
    sideslipDamping: [0, 10],
    excessClimbDamping: [0, 10]
};

/**
 * aircraftPhysics オブジェクトのキーごとにレンジ検証する
 * @param {unknown} ap
 * @param {string} pathLabel 例: ワールド「lobby」: aircraftPhysics
 * @param {string[]} errors
 */
function appendAircraftPhysicsValidationErrors(ap, pathLabel, errors) {
    if (ap == null) return;
    if (typeof ap !== 'object' || Array.isArray(ap)) {
        errors.push(`${pathLabel} はオブジェクトである必要があります`);
        return;
    }
    for (const [key, [lo, hi]] of Object.entries(AIRCRAFT_PHYSICS_LIMITS)) {
        if (!(key in ap)) continue;
        const v = ap[key];
        if (typeof v !== 'number' || !Number.isFinite(v)) {
            errors.push(`${pathLabel}.${key} は有限の数値にしてください`);
            continue;
        }
        if (v < lo || v > hi) {
            errors.push(`${pathLabel}.${key} は ${lo}〜${hi} にしてください`);
        }
    }
}

/**
 * aircraftPhysics（飛行機操縦の数値）検証（POST /admin/worlds 用）
 * @param {Record<string, unknown>} worlds
 * @returns {string[]}
 */
function validateWorldsAircraftPhysics(worlds) {
    const errors = [];
    if (!worlds || typeof worlds !== 'object') return errors;
    for (const [wid, w] of Object.entries(worlds)) {
        if (!w || typeof w !== 'object') continue;
        const ap = w.aircraftPhysics;
        if (ap == null) continue;
        appendAircraftPhysicsValidationErrors(ap, `ワールド「${wid}」: aircraftPhysics`, errors);
    }
    return errors;
}

/**
 * 表示用床プレーンの寸法（floorWidth / floorDepth）検証（POST /admin/worlds 用）
 * @param {Record<string, unknown>} worlds
 * @returns {string[]}
 */
function validateWorldsFloorDimensions(worlds) {
    const errors = [];
    if (!worlds || typeof worlds !== 'object') return errors;
    const lo = 10;
    const hi = 200000;
    for (const [wid, w] of Object.entries(worlds)) {
        if (!w || typeof w !== 'object') continue;
        for (const key of ['floorWidth', 'floorDepth']) {
            if (!(key in w)) continue;
            const v = w[key];
            if (typeof v !== 'number' || !Number.isFinite(v)) {
                errors.push(`ワールド「${wid}」: ${key} は有限の数値にしてください`);
                continue;
            }
            if (v < lo || v > hi) {
                errors.push(`ワールド「${wid}」: ${key} は ${lo}〜${hi}（m）にしてください`);
            }
        }
    }
    return errors;
}

/**
 * playBounds / serverColliders の形を検証（POST /admin/worlds 用）
 * @param {Record<string, unknown>} worlds
 * @returns {string[]}
 */
function validateWorldsPlayBoundsAndColliders(worlds) {
    const errors = [];
    if (!worlds || typeof worlds !== 'object') return errors;
    for (const [wid, w] of Object.entries(worlds)) {
        if (!w || typeof w !== 'object') continue;
        const pb = w.playBounds;
        if (pb != null) {
            if (typeof pb !== 'object' || !pb.min || !pb.max) {
                errors.push(`ワールド「${wid}」: playBounds は { min:{x,y,z}, max:{x,y,z} } 形式にしてください`);
                continue;
            }
            const axes = ['x', 'y', 'z'];
            for (const ax of axes) {
                if (!(ax in pb.min) || !(ax in pb.max)) {
                    errors.push(`ワールド「${wid}」: playBounds.min/max に ${ax} が必要です`);
                    continue;
                }
                const a = pb.min[ax];
                const b = pb.max[ax];
                if (typeof a !== 'number' || typeof b !== 'number' || !Number.isFinite(a) || !Number.isFinite(b)) {
                    errors.push(`ワールド「${wid}」: playBounds.min/max の ${ax} は有限数値にしてください`);
                } else if (a > b) {
                    errors.push(`ワールド「${wid}」: playBounds の min.${ax} は max.${ax} 以下にしてください`);
                }
            }
        }
        const sc = w.serverColliders;
        if (sc != null) {
            if (!Array.isArray(sc)) {
                errors.push(`ワールド「${wid}」: serverColliders は配列にしてください`);
                continue;
            }
            sc.forEach((box, i) => {
                if (!box || typeof box !== 'object' || !box.min || !box.max) {
                    errors.push(`ワールド「${wid}」: serverColliders[${i}] は { min, max } 形式にしてください`);
                    return;
                }
                for (const ax of ['x', 'y', 'z']) {
                    const a = box.min[ax];
                    const b = box.max[ax];
                    if (typeof a !== 'number' || typeof b !== 'number' || !Number.isFinite(a) || !Number.isFinite(b)) {
                        errors.push(`ワールド「${wid}」: serverColliders[${i}] の min/max.${ax} は有限数値にしてください`);
                    } else if (a > b) {
                        errors.push(`ワールド「${wid}」: serverColliders[${i}] の min.${ax} は max.${ax} 以下にしてください`);
                    }
                }
            });
        }
    }
    return errors;
}

/**
 * aircraft メタデータの検証（同一ワールド内 id 一意）
 * @param {Record<string, unknown>} worlds
 * @returns {string[]}
 */
function validateWorldsAircraft(worlds) {
    const errors = [];
    if (!worlds || typeof worlds !== 'object') return errors;
    for (const [wid, w] of Object.entries(worlds)) {
        if (!w || typeof w !== 'object' || !Array.isArray(w.models)) continue;
        const seen = new Set();
        w.models.forEach((m, i) => {
            const a = m && m.aircraft;
            if (!a || typeof a !== 'object') return;
            const id = String(a.id || '').trim();
            if (!id) {
                errors.push(`ワールド「${wid}」オブジェクト#${i + 1}: aircraft.id が必要です`);
                return;
            }
            if (seen.has(id)) {
                errors.push(`ワールド「${wid}」: aircraft.id「${id}」が重複しています`);
            }
            seen.add(id);
            const r = a.radius;
            if (r != null && (typeof r !== 'number' || !Number.isFinite(r) || r <= 0)) {
                errors.push(`ワールド「${wid}」 aircraft「${id}」: radius は正の有限数値にしてください`);
            }
            if (a.aircraftPhysics != null) {
                appendAircraftPhysicsValidationErrors(
                    a.aircraftPhysics,
                    `ワールド「${wid}」 aircraft「${id}」: aircraftPhysics`,
                    errors
                );
            }
        });
    }
    return errors;
}

/**
 * @param {string} worldId
 * @param {string} slotId
 * @returns {boolean}
 */
function worldContainsAircraftSlot(worldId, slotId) {
    const worlds = readWorlds();
    const w = worlds[worldId];
    if (!w || !Array.isArray(w.models)) return false;
    const sid = String(slotId || '').trim();
    return w.models.some((m) => m && m.aircraft && String(m.aircraft.id || '').trim() === sid);
}

/**
 * @param {import('socket.io').Server} ioSrv
 * @param {string} roomId
 * @param {string} socketId
 */
function releaseAllAircraftForPlayerInRoom(ioSrv, roomId, socketId) {
    const rs = roomStates.get(roomId);
    if (!rs || !rs.aircraft) return;
    const released = [];
    for (const [slotId, pilotId] of rs.aircraft.pilots) {
        if (pilotId === socketId) {
            rs.aircraft.pilots.delete(slotId);
            rs.aircraft.poses.delete(slotId);
            released.push(slotId);
        }
    }
    const player = rs.players.get(socketId);
    if (player) player.pilotingAircraftId = null;
    for (const slotId of released) {
        ioSrv.to(roomId).emit('aircraft-released', { slotId });
    }
}

/**
 * @param {{ aircraft?: { pilots: Map<string, string>, poses: Map<string, { position: object, quaternion: object }> } }} rs
 * @returns {{ id: string, pilotId: string, position: object, quaternion: object }[]}
 */
function buildAircraftSnapshotList(rs) {
    if (!rs?.aircraft?.pilots?.size) return [];
    const list = [];
    for (const [slotId, pilotSocketId] of rs.aircraft.pilots) {
        const pose = rs.aircraft.poses.get(slotId);
        if (!pose || !pose.position || !pose.quaternion) continue;
        const p = pose.position;
        const q = pose.quaternion;
        if (![p.x, p.y, p.z].every((n) => typeof n === 'number' && Number.isFinite(n))) continue;
        if (![q.x, q.y, q.z, q.w].every((n) => typeof n === 'number' && Number.isFinite(n))) continue;
        list.push({
            id: slotId,
            pilotId: pilotSocketId,
            position: { x: p.x, y: p.y, z: p.z },
            quaternion: { x: q.x, y: q.y, z: q.z, w: q.w }
        });
    }
    return list;
}

/**
 * @param {number} px
 * @param {number} py
 * @param {number} pz
 * @param {{ min: {x:number,y:number,z:number}, max: {x:number,y:number,z:number} }} box
 */
function pointInsidePlayAabb(px, py, pz, box) {
    return px >= box.min.x && px <= box.max.x
        && py >= box.min.y && py <= box.max.y
        && pz >= box.min.z && pz <= box.max.z;
}

/**
 * 移動線分がソリッド AABB 内を通過するか（サンプリング）。足元・頭高の2点を各 t で判定。
 * @param {number} ax
 * @param {number} ay
 * @param {number} az
 * @param {number} bx
 * @param {number} by
 * @param {number} bz
 * @param {{ min: object, max: object }} solid
 */
function segmentIntersectsSolidAabb(ax, ay, az, bx, by, bz, solid, steps = 16) {
    for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const x = ax + (bx - ax) * t;
        const y0 = ay + (by - ay) * t;
        const z = az + (bz - az) * t;
        const y1 = y0 + SERVER_CAPSULE_HEIGHT;
        if (pointInsidePlayAabb(x, y0, z, solid) || pointInsidePlayAabb(x, y1, z, solid)) {
            return true;
        }
    }
    return false;
}

/**
 * playBounds 内にクランプ
 * @param {{ x: number, y: number, z: number }} pos
 * @param {unknown} pb
 */
function clampPositionToPlayBounds(pos, pb) {
    if (!pb || typeof pb !== 'object' || !pb.min || !pb.max) return pos;
    const { min, max } = pb;
    return {
        x: Math.min(max.x, Math.max(min.x, pos.x)),
        y: Math.min(max.y, Math.max(min.y, pos.y)),
        z: Math.min(max.z, Math.max(min.z, pos.z))
    };
}

/**
 * Low ティア: 速度・playBounds・serverColliders。戻り値は補正後位置と full 補正フラグ。
 * @param {{ x: number, y: number, z: number }} candidate
 * @param {{ x: number, y: number, z: number }|null} authPrev
 * @param {number} prevAtMs
 * @param {unknown} wcfg
 */
function applyLowTierPositionChecks(candidate, authPrev, prevAtMs, wcfg) {
    let x = candidate.x;
    let y = candidate.y;
    let z = candidate.z;
    let usedFullCorrection = false;

    const now = Date.now();
    const dtSec = Math.max(0.001, (now - prevAtMs) / 1000);

    if (authPrev && Number.isFinite(authPrev.x) && Number.isFinite(authPrev.y) && Number.isFinite(authPrev.z)) {
        const dx = x - authPrev.x;
        const dz = z - authPrev.z;
        const horiz = Math.sqrt(dx * dx + dz * dz) / dtSec;
        if (horiz > PHYSICS_LOW_MAX_HORIZ_SPEED) {
            x = authPrev.x;
            y = authPrev.y;
            z = authPrev.z;
            usedFullCorrection = true;
        }
    }

    const next = { x, y, z };
    if (wcfg && typeof wcfg === 'object' && wcfg.playBounds) {
        const clamped = clampPositionToPlayBounds(next, wcfg.playBounds);
        if (clamped.x !== next.x || clamped.y !== next.y || clamped.z !== next.z) {
            next.x = clamped.x;
            next.y = clamped.y;
            next.z = clamped.z;
            usedFullCorrection = true;
        }
    }

    const colliders = wcfg && typeof wcfg === 'object' && Array.isArray(wcfg.serverColliders) ? wcfg.serverColliders : [];
    if (colliders.length > 0) {
        for (const solid of colliders) {
            if (!solid || typeof solid !== 'object' || !solid.min || !solid.max) continue;
            if (authPrev && Number.isFinite(authPrev.x)
                && segmentIntersectsSolidAabb(authPrev.x, authPrev.y, authPrev.z, next.x, next.y, next.z, solid)) {
                next.x = authPrev.x;
                next.y = authPrev.y;
                next.z = authPrev.z;
                usedFullCorrection = true;
                break;
            }
            if (pointInsidePlayAabb(next.x, next.y, next.z, solid)
                || pointInsidePlayAabb(next.x, next.y + SERVER_CAPSULE_HEIGHT, next.z, solid)) {
                if (authPrev && Number.isFinite(authPrev.x)) {
                    next.x = authPrev.x;
                    next.y = authPrev.y;
                    next.z = authPrev.z;
                    usedFullCorrection = true;
                    break;
                }
            }
        }
    }

    return { pos: next, usedFullCorrection };
}

/**
 * クライアント足元Yを worlds.physicsAssist でクランプする（段階A）
 * @param {unknown} worldConfig
 * @param {number} feetY
 * @returns {{ y: number, changed: boolean }}
 */
function clampPlayerFeetYForWorld(worldConfig, feetY) {
    if (typeof feetY !== 'number' || !Number.isFinite(feetY)) {
        return { y: feetY, changed: false };
    }
    const pa = worldConfig && typeof worldConfig === 'object' && worldConfig.physicsAssist;
    if (!pa || typeof pa !== 'object' || pa.enabled !== true) {
        return { y: feetY, changed: false };
    }
    let next = feetY;
    let changed = false;
    if (typeof pa.minFeetY === 'number' && Number.isFinite(pa.minFeetY) && next < pa.minFeetY) {
        next = pa.minFeetY;
        changed = true;
    }
    if (typeof pa.maxFeetY === 'number' && Number.isFinite(pa.maxFeetY) && next > pa.maxFeetY) {
        next = pa.maxFeetY;
        changed = true;
    }
    return { y: next, changed };
}

/**
 * @param {import('socket.io').Socket} socket
 */
function setPhysicsAssistGrace(socket) {
    socket.data.physicsAssistGraceUntil = Date.now() + PHYSICS_ASSIST_GRACE_MS;
}

const CHARTS_PATH = STORAGE_PATHS.CHARTS_PATH;
const DEFAULT_CHARTS = {};

function ensureChartsFile() {
    if (!fs.existsSync(CHARTS_PATH)) {
        fs.writeFileSync(CHARTS_PATH, JSON.stringify(DEFAULT_CHARTS, null, 2), 'utf8');
        console.log('Created charts.json');
    }
}

function readCharts() {
    try {
        const data = fs.readFileSync(CHARTS_PATH, 'utf8');
        return JSON.parse(data);
    } catch (err) {
        console.warn('Failed to read charts.json, using default:', err.message);
        return { ...DEFAULT_CHARTS };
    }
}

function writeCharts(charts) {
    const tmpPath = CHARTS_PATH + '.tmp.' + Date.now();
    fs.writeFileSync(tmpPath, JSON.stringify(charts, null, 2), 'utf8');
    fs.renameSync(tmpPath, CHARTS_PATH);
}

const MODELS_DIR = STORAGE_PATHS.MODELS_DIR;
const PDFS_DIR = STORAGE_PATHS.PDFS_DIR;
const IMAGES_DIR = STORAGE_PATHS.IMAGES_DIR;
const CHART_BGM_DIR = STORAGE_PATHS.CHART_BGM_DIR;
const ENV_DIR = STORAGE_PATHS.ENV_DIR;
const uploadStorage = multer.memoryStorage();
/** models 配下へアップロード可能な拡張子（GLB / OBJ / MTL / テクスチャ） */
const MODEL_UPLOAD_EXTS = new Set(['.glb', '.obj', '.mtl', '.png', '.jpg', '.jpeg', '.webp']);
/** 3D モデル一式アップロード（GLB 大容量など）。nginx client_max_body_size と揃える */
const upload = multer({
    storage: uploadStorage,
    limits: { fileSize: MODEL_UPLOAD_MAX_BYTES },
    fileFilter: (req, file, cb) => {
        const ext = path.extname(file.originalname || '').toLowerCase();
        cb(null, MODEL_UPLOAD_EXTS.has(ext));
    }
});
const uploadPdf = multer({
    storage: uploadStorage,
    fileFilter: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        const ok = ext === '.pdf' || file.mimetype === 'application/pdf';
        cb(null, !!ok);
    }
});
/** 譜面BGM（MP3）アップロード。最大約80MB */
const uploadChartBgm = multer({
    storage: uploadStorage,
    limits: { fileSize: 80 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const ext = path.extname(file.originalname || '').toLowerCase();
        const ok = ext === '.mp3' && (
            file.mimetype === 'audio/mpeg' ||
            file.mimetype === 'audio/mp3' ||
            file.mimetype === 'application/octet-stream'
        );
        cb(null, !!ok);
    }
});
/** IBL 用 Radiance HDR（RGBE）。クライアントは /env/default.hdr を読む */
const uploadHdr = multer({
    storage: uploadStorage,
    limits: { fileSize: 120 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const ext = path.extname(file.originalname || '').toLowerCase();
        cb(null, ext === '.hdr');
    }
});
/** Prefab バンドル（複数 GLB + 同梱アセット）ZIP */
const uploadPrefabZip = multer({
    storage: uploadStorage,
    limits: { fileSize: MODEL_UPLOAD_MAX_BYTES },
    fileFilter: (req, file, cb) => {
        const ext = path.extname(file.originalname || '').toLowerCase();
        const byMime =
            file.mimetype === 'application/zip' ||
            file.mimetype === 'application/x-zip-compressed' ||
            file.mimetype === 'application/zip-compressed';
        cb(null, ext === '.zip' || byMime);
    },
});
/**
 * multipart 由来の文字化けを避けるため、クライアント送信の UTF-8(base64) ファイル名を優先して正規化する。
 * @param {import('express').Request} req
 * @param {string} fallbackName
 * @returns {string}
 */
function getSafeUploadedFilename(req, fallbackName) {
    let filename = fallbackName;
    if (req.body && typeof req.body.filename_b64 === 'string') {
        try {
            filename = Buffer.from(req.body.filename_b64, 'base64').toString('utf8');
        } catch (_) {
            filename = fallbackName;
        }
    }
    const rawName = path.basename(String(filename || '')).replace(/[/\\\0]/g, '');
    return decodeLikelyMojibakeFilename(rawName);
}

/**
 * UTF-8 バイト列が latin1 として解釈された文字化けを、日本語を含む元文字列へ復元する。
 * @param {string} filename
 * @returns {string}
 */
function decodeLikelyMojibakeFilename(filename) {
    const source = String(filename || '');
    const decoded = Buffer.from(source, 'latin1').toString('utf8');
    const hasJapanese = /[\u3040-\u30ff\u3400-\u9fff]/.test(decoded);
    const hasLatin1Noise = /[\u0080-\u00ff]/.test(source);
    return hasJapanese && hasLatin1Noise ? decoded : source;
}

/**
 * クライアントのキャッシュ無効化用に、静的配信と同じ URL パスを組み立てる
 * @param {'models' | 'pdfs' | 'env' | 'images' | 'chart-bgm'} base
 * @param {string} filename
 * @returns {string}
 */
function publicAssetUrlForCache(base, filename) {
    const parts = String(filename || '').split(/[/\\]/).filter(Boolean);
    const tail = parts.map((p) => encodeURIComponent(p)).join('/');
    switch (base) {
        case 'pdfs':
            return '/pdfs/' + tail;
        case 'env':
            return '/env/' + tail;
        case 'images':
            return '/images/' + tail;
        case 'chart-bgm':
            return '/chart-bgm/' + tail;
        default: {
            if (USE_S3_MODELS) {
                const posix = parts.join('/');
                return publicAssetUrlCacheForModels(posix);
            }
            return '/models/' + tail;
        }
    }
}

/** ファイル管理 UI 用・許可されたストアキー → 絶対パス */
const STORAGE_FILE_STORE_ROOTS = {
    models: MODELS_DIR,
    pdfs: PDFS_DIR,
    images: IMAGES_DIR,
    env: ENV_DIR,
    'chart-bgm': CHART_BGM_DIR,
};

/**
 * ストアルート配下に解決する。パストラバーサルやヌルバイトは拒否する。
 * @param {string} storeRoot
 * @param {string} relativePath
 * @returns {string | null}
 */
function resolvePathUnderStorageRoot(storeRoot, relativePath) {
    const rel = String(relativePath ?? '').replace(/\\/g, '/').trim();
    if (rel.includes('\0')) return null;
    const segments = rel.split('/').filter(Boolean);
    if (segments.some((p) => p === '..')) return null;
    const joined = segments.length ? path.join(storeRoot, ...segments) : storeRoot;
    const resolved = path.resolve(joined);
    const rootResolved = path.resolve(storeRoot);
    const sep = path.sep;
    if (resolved === rootResolved) return resolved;
    if (!resolved.startsWith(rootResolved + sep)) return null;
    return resolved;
}

const app = express();

/**
 * 環境変数を真として解釈する（1 / true / yes / on）
 * @param {string | undefined} v
 * @returns {boolean}
 */
function isTruthyEnv(v) {
    const s = String(v ?? '').trim().toLowerCase();
    return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}

/**
 * Basic 認証配下の管理 API 用 500 応答。本番では内部情報を返さない。
 * @param {import('express').Response} res
 * @param {unknown} err
 */
function sendAdminServerError(res, err) {
    const message = err instanceof Error ? err.message : String(err);
    if (isNodeProduction) {
        return res.status(500).json({ error: 'Internal server error' });
    }
    return res.status(500).json({ error: message });
}

/**
 * SOCKET_CORS_ORIGINS をパースする（改行またはカンマ区切り）
 * @returns {string[]}
 */
function parseSocketAllowedOrigins() {
    return String(process.env.SOCKET_CORS_ORIGINS || '')
        .split(/[\r\n,]+/)
        .map((s) => s.trim())
        .filter(Boolean);
}

/**
 * 本番起動前の必須セキュリティ設定を検証する
 */
function assertProductionSecurityBeforeListen() {
    if (!isNodeProduction) return;
    const sk = String(process.env.SOCKET_AUTH_SECRET || '').trim();
    if (sk.length < 16) {
        throw new Error('[security] NODE_ENV=production requires SOCKET_AUTH_SECRET (min 16 characters).');
    }
    if (parseSocketAllowedOrigins().length === 0) {
        throw new Error(
            '[security] NODE_ENV=production requires SOCKET_CORS_ORIGINS (comma-separated browser origins, e.g. https://meta.example.com).'
        );
    }
}

/**
 * Socket.io 用 CORS 設定（credentials 利用のため本番は明示 Origin リスト必須）
 * @returns {{ origin: Function, credentials: boolean, methods: string[] }}
 */
function buildSocketIoCors() {
    const allowed = parseSocketAllowedOrigins();
    const allowMissingOrigin = isTruthyEnv(process.env.SOCKET_CORS_ALLOW_MISSING_ORIGIN);
    return {
        origin: (origin, callback) => {
            if (!isNodeProduction) {
                return callback(null, true);
            }
            if (!origin) {
                if (allowMissingOrigin) return callback(null, true);
                return callback(new Error('socket.io CORS: missing Origin (set SOCKET_CORS_ALLOW_MISSING_ORIGIN=1 only if needed)'));
            }
            if (allowed.includes(origin)) {
                return callback(null, true);
            }
            return callback(new Error('socket.io CORS: origin not allowed'));
        },
        credentials: true,
        methods: ['GET', 'POST'],
    };
}

const authLoginIpLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 40,
    standardHeaders: true,
    legacyHeaders: false,
});

const authRegisterIpLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
});

/** 公開スコア API の IP レート制限（同一 LAN 集約を考慮し緩め） */
const chartScoreIpLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 120,
    standardHeaders: true,
    legacyHeaders: false,
});

/**
 * PROXY_DOMAIN_PORT_MAP をパースする。改行またはカンマ区切り、各項目は host=port
 * @param {string | undefined} raw
 * @returns {Map<string, number>}
 */
function parseProxyDomainPortMap(raw) {
    const map = new Map();
    if (!raw || typeof raw !== 'string') return map;
    const parts = raw.split(/[\r\n,]+/).map((p) => p.trim()).filter(Boolean);
    for (const part of parts) {
        const eq = part.indexOf('=');
        if (eq <= 0) continue;
        const host = part.slice(0, eq).trim().toLowerCase();
        const portStr = part.slice(eq + 1).trim();
        const port = parseInt(portStr, 10);
        if (!host || !Number.isFinite(port) || port < 1 || port > 65535) continue;
        if (map.has(host) && map.get(host) !== port) {
            throw new Error(`PROXY_DOMAIN_PORT_MAP: host "${host}" has conflicting ports`);
        }
        map.set(host, port);
    }
    return map;
}

const useReverseProxy = isTruthyEnv(process.env.USE_REVERSE_PROXY);
/** 1/true/yes/on のとき、TLS 相当でない HTTP レイヤー要求を 403 で拒否（平文 HTTP の受け入れを止める） */
const requireSecureHttp = isTruthyEnv(process.env.REQUIRE_SECURE_HTTP);
const proxyDomainPortMap = parseProxyDomainPortMap(process.env.PROXY_DOMAIN_PORT_MAP);
const PROXY_SERVICE_DOMAIN = String(process.env.PROXY_SERVICE_DOMAIN || '').trim().toLowerCase();

let PORT = process.env.PORT !== undefined && process.env.PORT !== ''
    ? parseInt(process.env.PORT, 10)
    : 3000;
if (Number.isNaN(PORT)) PORT = 3000;

if (useReverseProxy && PROXY_SERVICE_DOMAIN) {
    if (proxyDomainPortMap.size === 0) {
        throw new Error('PROXY_SERVICE_DOMAIN is set but PROXY_DOMAIN_PORT_MAP is empty or invalid');
    }
    const mappedPort = proxyDomainPortMap.get(PROXY_SERVICE_DOMAIN);
    if (mappedPort === undefined) {
        throw new Error(
            `PROXY_SERVICE_DOMAIN="${PROXY_SERVICE_DOMAIN}" not found in PROXY_DOMAIN_PORT_MAP`
        );
    }
    if (process.env.PORT !== undefined && process.env.PORT !== '' && parseInt(process.env.PORT, 10) !== mappedPort) {
        throw new Error(
            `PORT (${process.env.PORT}) must match PROXY_DOMAIN_PORT_MAP for ${PROXY_SERVICE_DOMAIN} (${mappedPort})`
        );
    }
    PORT = mappedPort;
}

if (useReverseProxy) {
    const tpRaw = String(process.env.TRUST_PROXY ?? '').trim();
    const tpLower = tpRaw.toLowerCase();
    if (tpLower !== '0' && tpLower !== 'false' && tpLower !== 'off' && tpLower !== 'no') {
        if (tpRaw === '' || tpLower === '1' || tpLower === 'true' || tpLower === 'yes' || tpLower === 'on') {
            app.set('trust proxy', 1);
        } else if (/^\d+$/.test(tpRaw)) {
            app.set('trust proxy', parseInt(tpRaw, 10));
        } else {
            app.set('trust proxy', tpRaw);
        }
    }
}

if (requireSecureHttp && useReverseProxy && !app.get('trust proxy')) {
    console.warn(
        '[security] REQUIRE_SECURE_HTTP=1 with USE_REVERSE_PROXY=1 but trust proxy is off; req.secure may be false. Set TRUST_PROXY=1 (or unset) so X-Forwarded-Proto is honored.'
    );
}

assertProductionSecurityBeforeListen();

/**
 * REQUIRE_SECURE_HTTP 時に、Express が TLS とみなさない要求を拒否する（Basic 等の平文漏えい対策）
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
function rejectNonTlsHttpLayer(req, res, next) {
    if (!requireSecureHttp) return next();
    if (req.secure) return next();
    res.status(403).type('text/plain; charset=utf-8').send('HTTPS required (REQUIRE_SECURE_HTTP=1)');
}

app.use(cookieParser());
app.use(rejectNonTlsHttpLayer);
// Helmet CSP は Vite 出力・インライン方針と衝突するため無効。nonce やハッシュで script-src を組む段階的 CSP は別タスク。
app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' },
}));
app.use(express.json({ limit: '1mb' }));

/** HTTPS: SSL_CERT_PATH と SSL_KEY_PATH が両方設定されていれば HTTPS で待ち受ける（リバースプロキシ時は無効） */
const SSL_CERT_PATH = process.env.SSL_CERT_PATH;
const SSL_KEY_PATH = process.env.SSL_KEY_PATH;
const PORT_HTTP_REDIRECT = process.env.PORT_HTTP_REDIRECT ? parseInt(process.env.PORT_HTTP_REDIRECT, 10) : 0;

const hasSsl =
    !useReverseProxy &&
    SSL_CERT_PATH && SSL_KEY_PATH &&
    fs.existsSync(SSL_CERT_PATH) && fs.existsSync(SSL_KEY_PATH);

if (requireSecureHttp && !hasSsl && !useReverseProxy) {
    throw new Error(
        '[security] REQUIRE_SECURE_HTTP=1 needs TLS: set USE_REVERSE_PROXY=1 with HTTPS at nginx/Caddy (and TRUST_PROXY), or set SSL_CERT_PATH + SSL_KEY_PATH for Node HTTPS.'
    );
}

const httpServer = hasSsl
    ? https.createServer(
        {
            key: fs.readFileSync(SSL_KEY_PATH),
            cert: fs.readFileSync(SSL_CERT_PATH),
        },
        app
    )
    : http.createServer(app);

const io = new Server(httpServer, {
    cors: buildSocketIoCors(),
});

/** Bind to 0.0.0.0 for LAN access; use 127.0.0.1 for localhost only */
const HOST = process.env.HOST || '0.0.0.0';

/** Returns IPv4 LAN addresses (non-internal) for display */
function getLanIps() {
    const nets = os.networkInterfaces();
    const ips = [];
    for (const name of Object.keys(nets)) {
        for (const net of nets[name]) {
            if (net.family === 'IPv4' && !net.internal) {
                ips.push(net.address);
            }
        }
    }
    return ips;
}
const VC_DEBUG_STATS = process.env.VC_DEBUG_STATS === '1';

// ============================
// mediasoup Configuration
// ============================
const MEDIASOUP_ANNOUNCED_IP = process.env.MEDIASOUP_ANNOUNCED_IP;
/** 同一 LAN 内クライアント向けの第2 ICE 候補（例: 192.168.0.74）。公衆 MEDIASOUP_ANNOUNCED_IP のみだと家の Wi‑Fi から WebRTC が届かないことがある */
const MEDIASOUP_ANNOUNCED_LAN_IP = String(process.env.MEDIASOUP_ANNOUNCED_LAN_IP || '').trim();
const MEDIASOUP_ENABLE_LOCALHOST =
    process.env.MEDIASOUP_ENABLE_LOCALHOST === '1' || process.env.NODE_ENV !== 'production';

if (process.env.NODE_ENV === 'production' && !MEDIASOUP_ANNOUNCED_IP) {
    console.warn(
        '[VC] NODE_ENV=production but MEDIASOUP_ANNOUNCED_IP is not set. ' +
        'External WebRTC clients may fail to connect. ' +
        'Set MEDIASOUP_ANNOUNCED_IP to your public IP or domain (e.g. mmh-virtual.jp).'
    );
}

/**
 * mediasoup WebRtcTransport の listenIps（0.0.0.0 + 公衆 announced、任意で LAN・localhost）
 * @returns {{ ip: string, announcedIp?: string }[]}
 */
function buildMediasoupListenIps() {
    const listenIps = [
        {
            ip: '0.0.0.0',
            announcedIp: MEDIASOUP_ANNOUNCED_IP || undefined,
        },
    ];
    if (MEDIASOUP_ANNOUNCED_LAN_IP) {
        listenIps.push({
            ip: MEDIASOUP_ANNOUNCED_LAN_IP,
            announcedIp: MEDIASOUP_ANNOUNCED_LAN_IP,
        });
    }
    if (MEDIASOUP_ENABLE_LOCALHOST) {
        listenIps.push({
            ip: '127.0.0.1',
            announcedIp: '127.0.0.1',
        });
    }
    return listenIps;
}

// VC (mediasoup) UDP port range - configurable via .env
const VC_RTC_MIN_PORT = parseInt(process.env.VC_RTC_MIN_PORT || '10000', 10);
const VC_RTC_MAX_PORT = parseInt(process.env.VC_RTC_MAX_PORT || '10100', 10);

// PDF Viewer VC UDP port range - configurable via .env
const PDF_VC_RTC_MIN_PORT = parseInt(process.env.PDF_VC_RTC_MIN_PORT || '20000', 10);
const PDF_VC_RTC_MAX_PORT = parseInt(process.env.PDF_VC_RTC_MAX_PORT || '20100', 10);

// Video VC UDP port range - configurable via .env
const VIDEO_VC_RTC_MIN_PORT = parseInt(process.env.VIDEO_VC_RTC_MIN_PORT || '30000', 10);
const VIDEO_VC_RTC_MAX_PORT = parseInt(process.env.VIDEO_VC_RTC_MAX_PORT || '31000', 10);
const VIDEO_VC_MAX_PRODUCERS_PER_ROOM = parseInt(process.env.VIDEO_VC_MAX_PRODUCERS_PER_ROOM || '10', 10);

/** 音声・PDF・ビデオ VC それぞれの mediasoup Router 同時保持数上限（ルータ乱立の緩和） */
const VC_MAX_MEDIASOUP_ROUTERS = (() => {
    const n = parseInt(process.env.VC_MAX_ROUTERS || '128', 10);
    const v = Number.isFinite(n) && n > 0 ? n : 128;
    return Math.max(4, Math.min(4096, v));
})();

const mediasoupConfig = {
    worker: {
        rtcMinPort: VC_RTC_MIN_PORT,
        rtcMaxPort: VC_RTC_MAX_PORT,
        logLevel: 'warn',
        logTags: [
            'info',
            'ice',
            'dtls',
            'rtp',
            'srtp',
            'rtcp',
        ],
    },
    router: {
        mediaCodecs: [
            {
                kind: 'audio',
                mimeType: 'audio/opus',
                clockRate: 48000,
                channels: 2,
            },
        ],
    },
    webRtcTransport: {
        listenIps: buildMediasoupListenIps(),
        maxIncomingBitrate: 150000, // 150kbps for audio
        initialAvailableOutgoingBitrate: 600000,
    },
};

// PDF Viewer VC: separate worker config (different port range)
const pdfVcMediasoupConfig = {
    worker: {
        rtcMinPort: PDF_VC_RTC_MIN_PORT,
        rtcMaxPort: PDF_VC_RTC_MAX_PORT,
        logLevel: 'warn',
        logTags: ['info', 'ice', 'dtls', 'rtp', 'srtp', 'rtcp'],
    },
    router: { mediaCodecs: mediasoupConfig.router.mediaCodecs },
    webRtcTransport: mediasoupConfig.webRtcTransport,
};

// Video VC: separate worker config with video codecs
const videoVcMediasoupConfig = {
    worker: {
        rtcMinPort: VIDEO_VC_RTC_MIN_PORT,
        rtcMaxPort: VIDEO_VC_RTC_MAX_PORT,
        logLevel: 'warn',
        logTags: ['info', 'ice', 'dtls', 'rtp', 'srtp', 'rtcp'],
    },
    router: {
        mediaCodecs: [
            { kind: 'audio', mimeType: 'audio/opus', clockRate: 48000, channels: 2 },
            { kind: 'video', mimeType: 'video/VP8', clockRate: 90000, rtcpFeedback: [{ type: 'nack' }, { type: 'nack', parameter: 'pli' }, { type: 'ccm', parameter: 'fir' }, { type: 'goog-remb' }, { type: 'transport-cc' }] },
            { kind: 'video', mimeType: 'video/H264', clockRate: 90000, parameters: { 'level-asymmetry-allowed': 1 }, rtcpFeedback: [{ type: 'nack' }, { type: 'nack', parameter: 'pli' }, { type: 'ccm', parameter: 'fir' }, { type: 'goog-remb' }, { type: 'transport-cc' }] },
        ],
    },
    webRtcTransport: {
        ...mediasoupConfig.webRtcTransport,
        maxIncomingBitrate: 5000000, // 5Mbps for video (incl. 1080p)
    },
};

// mediasoup Worker Pool
const workers = [];
let nextWorkerIndex = 0;

// PDF VC Worker Pool
const pdfWorkers = [];
let nextPdfWorkerIndex = 0;

// VC Room Routers: Map<roomId, Router>
const vcRouters = new Map();

// VC Peers: Map<socketId, { transports, producers, consumers }>
const vcPeers = new Map();

// PDF VC: Map<pdfRoomId, Router> and Map<socketId, peer state>
const pdfVcRouters = new Map();
const pdfVcPeers = new Map();

// Video VC: Map<roomId, Router> and Map<socketId, peer state>
const videoVcWorkers = [];
let nextVideoVcWorkerIndex = 0;
const videoVcRouters = new Map();
const videoVcPeers = new Map();

// Max simultaneous active producers (mic ON) per room
const MAX_ACTIVE_PRODUCERS_PER_ROOM = 10;

// ICE servers configuration (STUN/TURN)
let cachedIceServers = null;
let iceServersExpiry = 0;

async function fetchCloudflareIceServers() {
    const apiToken = process.env.CLOUDFLARE_TURN_API_TOKEN;
    const keyId = process.env.CLOUDFLARE_TURN_KEY_ID;
    
    if (!apiToken || !keyId) {
        console.log('[VC] Cloudflare TURN not configured (missing API_TOKEN or KEY_ID)');
        return null;
    }
    
    try {
        const response = await fetch(
            `https://rtc.live.cloudflare.com/v1/turn/keys/${keyId}/credentials/generate-ice-servers`,
            {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${apiToken}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ ttl: 86400 }), // 24 hours
            }
        );
        
        if (!response.ok) {
            throw new Error(`Cloudflare API error: ${response.status}`);
        }
        
        const data = await response.json();
        console.log('[VC] Cloudflare ICE servers fetched successfully');
        return data.iceServers;
    } catch (error) {
        console.error('[VC] Failed to fetch Cloudflare ICE servers:', error);
        return null;
    }
}

async function getIceServers() {
    const now = Date.now();
    
    // Return cached servers if still valid
    if (cachedIceServers && now < iceServersExpiry) {
        return cachedIceServers;
    }
    
    // Try to fetch from Cloudflare
    const cloudflareServers = await fetchCloudflareIceServers();
    
    if (cloudflareServers) {
        cachedIceServers = cloudflareServers;
        // Refresh 1 hour before expiry (23 hours)
        iceServersExpiry = now + (23 * 60 * 60 * 1000);
        console.log('[VC] Using Cloudflare ICE servers');
        return cachedIceServers;
    }
    
    // Fallback to Google STUN
    const fallbackServers = [
        {
            urls: ['stun:stun.l.google.com:19302'],
        },
    ];
    
    console.log('[VC] Using fallback STUN only');
    return fallbackServers;
}

// ============================
// Admin: Basic Authentication
// ============================
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const envAdminPassword = String(process.env.ADMIN_PASSWORD ?? '').trim();
const ADMIN_PASSWORD = envAdminPassword.length > 0
    ? envAdminPassword
    : (() => {
        const generated = crypto.randomUUID();
        console.log('[security] ADMIN_PASSWORD unset; generated one-time Basic auth password (set ADMIN_PASSWORD in .env to keep it across restarts).');
        console.log(`[security] Admin user: ${ADMIN_USERNAME}`);
        console.log(`[security] Admin password: ${generated}`);
        return generated;
    })();
// 通信帯域上限 (Mbps)。1 Mbps ≈ 125,000 bytes/s
const BANDWIDTH_LIMIT_MBPS = parseFloat(process.env.BANDWIDTH_LIMIT_MBPS || '100');
const BANDWIDTH_LIMIT_BPS = Math.floor(BANDWIDTH_LIMIT_MBPS * 125000);

/**
 * UTF-8 文字列をタイミングセーフに比較する
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function timingSafeEqualStr(a, b) {
    const bufa = Buffer.from(String(a), 'utf8');
    const bufb = Buffer.from(String(b), 'utf8');
    if (bufa.length !== bufb.length) return false;
    return crypto.timingSafeEqual(bufa, bufb);
}

function basicAuth(req, res, next) {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Basic ')) {
        res.setHeader('WWW-Authenticate', 'Basic realm="Admin Panel"');
        return res.status(401).send('認証が必要です');
    }

    const base64Credentials = authHeader.slice(6);
    let decoded;
    try {
        decoded = Buffer.from(base64Credentials, 'base64').toString('utf8');
    } catch {
        res.setHeader('WWW-Authenticate', 'Basic realm="Admin Panel"');
        return res.status(401).send('認証に失敗しました');
    }

    const sep = decoded.indexOf(':');
    const user = sep >= 0 ? decoded.slice(0, sep) : decoded;
    const pass = sep >= 0 ? decoded.slice(sep + 1) : '';

    if (timingSafeEqualStr(user, ADMIN_USERNAME) && timingSafeEqualStr(pass, ADMIN_PASSWORD)) {
        return next();
    }

    res.setHeader('WWW-Authenticate', 'Basic realm="Admin Panel"');
    return res.status(401).send('認証に失敗しました');
}

const SOCKET_AUTH_TOKEN_IN_JSON = isTruthyEnv(process.env.SOCKET_AUTH_TOKEN_IN_JSON);
const allowPublicRegistration = isTruthyEnv(process.env.ALLOW_PUBLIC_REGISTRATION) || !isNodeProduction;

/**
 * 本番では既定で無効な公開ユーザー登録を許可するか
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
function requirePublicRegistrationEnabled(req, res, next) {
    if (allowPublicRegistration) return next();
    res.status(403).json({ success: false, error: 'registration_disabled' });
}

/**
 * @returns {boolean} SOCKET_ALLOW_GUEST が 0/false/off/no のとき true（ゲスト接続を拒否）
 */
function isSocketGuestDisabled() {
    const s = String(process.env.SOCKET_ALLOW_GUEST ?? '').trim().toLowerCase();
    return s === '0' || s === 'false' || s === 'off' || s === 'no';
}

/**
 * @returns {boolean}
 */
function isAuthCookieSecure() {
    return isNodeProduction && process.env.COOKIE_SECURE !== '0';
}

/**
 * Socket 認証用 httpOnly Cookie を付与する
 * @param {import('express').Response} res
 * @param {string} token
 */
function setSocketAuthCookie(res, token) {
    res.cookie(SOCKET_AUTH_COOKIE_NAME, token, {
        httpOnly: true,
        secure: isAuthCookieSecure(),
        sameSite: 'lax',
        path: '/',
        maxAge: SOCKET_AUTH_TOKEN_MAX_AGE_MS,
    });
}

/**
 * HTTP リクエストから Socket 認証トークンを読む
 * @param {import('express').Request} req
 * @returns {string|null}
 */
function getSocketAuthTokenFromHttp(req) {
    const c = req.cookies?.[SOCKET_AUTH_COOKIE_NAME];
    return typeof c === 'string' && c.length > 0 ? c : null;
}

/**
 * S3 モデル本番モード時: /models GET はメタバース Socket 認証 Cookie または管理者 Basic のみ（直リンク抑止）
 * @param {import('express').Request} req
 * @returns {boolean}
 */
function metaverseModelsAccessAllowed(req) {
    if (!USE_S3_MODELS) return true;
    if (verifySocketAuthToken(getSocketAuthTokenFromHttp(req))) return true;
    const ah = req.headers.authorization;
    if (ah && ah.startsWith('Basic ')) {
        try {
            const decoded = Buffer.from(ah.slice(6), 'base64').toString('utf8');
            const sep = decoded.indexOf(':');
            const user = sep >= 0 ? decoded.slice(0, sep) : decoded;
            const pass = sep >= 0 ? decoded.slice(sep + 1) : '';
            if (timingSafeEqualStr(user, ADMIN_USERNAME) && timingSafeEqualStr(pass, ADMIN_PASSWORD)) return true;
        } catch {
            return false;
        }
    }
    return false;
}

/**
 * Socket ハンドシェイクからトークンを読む（httpOnly Cookie を auth ペイロードより優先）
 * @param {import('socket.io').Socket} socket
 * @returns {string|null}
 */
function getSocketAuthTokenFromHandshake(socket) {
    const raw = socket.handshake.headers?.cookie;
    if (raw && typeof raw === 'string') {
        try {
            const parsed = parseCookieHeader(raw);
            const c = parsed[SOCKET_AUTH_COOKIE_NAME];
            if (typeof c === 'string' && c.length > 0) return c;
        } catch {
            /* fall through */
        }
    }
    const fromAuth = socket.handshake.auth?.socketAuthToken;
    if (fromAuth && typeof fromAuth === 'string' && fromAuth.length > 0) return fromAuth;
    return null;
}

// ============================
// Auth API (student / teacher)
// ============================
app.get('/api/auth/session', (req, res) => {
    const raw = getSocketAuthTokenFromHttp(req);
    const verified = verifySocketAuthToken(raw);
    if (!verified) {
        return res.json({ authenticated: false });
    }
    res.json({ authenticated: true, role: verified.role });
});

app.post('/api/auth/logout', (req, res) => {
    res.clearCookie(SOCKET_AUTH_COOKIE_NAME, {
        path: '/',
        sameSite: 'lax',
        secure: isAuthCookieSecure(),
    });
    res.json({ success: true });
});

app.post('/api/auth/student/login', authLoginIpLimiter, (req, res) => {
    const { username, password } = req.body || {};
    if (!username || !password) {
        return res.status(400).json({ success: false, error: 'username and password required' });
    }
    const user = verifyStudent(username, password);
    if (!user) {
        return res.status(401).json({ success: false, error: 'invalid_credentials' });
    }
    const token = signSocketAuthToken({ role: 'student' });
    setSocketAuthCookie(res, token);
    const body = {
        success: true,
        username: user.displayName,
        displayName: user.displayName,
        role: 'student',
    };
    if (SOCKET_AUTH_TOKEN_IN_JSON) {
        body.socketAuthToken = token;
    }
    res.json(body);
});

app.post('/api/auth/teacher/login', authLoginIpLimiter, (req, res) => {
    const { username, password } = req.body || {};
    if (!username || !password) {
        return res.status(400).json({ success: false, error: 'username and password required' });
    }
    const user = verifyTeacher(username, password);
    if (!user) {
        return res.status(401).json({ success: false, error: 'invalid_credentials' });
    }
    const token = signSocketAuthToken({ role: 'teacher' });
    setSocketAuthCookie(res, token);
    const body = {
        success: true,
        username: user.displayName,
        displayName: user.displayName,
        role: 'teacher',
    };
    if (SOCKET_AUTH_TOKEN_IN_JSON) {
        body.socketAuthToken = token;
    }
    res.json(body);
});

app.post('/api/auth/register/student', authRegisterIpLimiter, requirePublicRegistrationEnabled, (req, res) => {
    const { username, password, displayName } = req.body || {};
    if (!username || !password) {
        return res.status(400).json({ success: false, error: 'username and password required' });
    }
    try {
        const user = registerStudent(username, password, displayName);
        res.json({ success: true, username: user.username, displayName: user.displayName, role: 'student' });
    } catch (e) {
        if (e.code === 'SQLITE_CONSTRAINT_UNIQUE') {
            return res.status(409).json({ success: false, error: 'username_exists' });
        }
        throw e;
    }
});

app.post('/api/auth/register/teacher', authRegisterIpLimiter, requirePublicRegistrationEnabled, (req, res) => {
    const { username, password, displayName } = req.body || {};
    if (!username || !password) {
        return res.status(400).json({ success: false, error: 'username and password required' });
    }
    try {
        const user = registerTeacher(username, password, displayName);
        res.json({ success: true, username: user.username, displayName: user.displayName, role: 'teacher' });
    } catch (e) {
        if (e.code === 'SQLITE_CONSTRAINT_UNIQUE') {
            return res.status(409).json({ success: false, error: 'username_exists' });
        }
        throw e;
    }
});

// Redirect legacy login.html to /login/
app.get('/login.html', (req, res) => {
    res.redirect(301, '/login/');
});

// ログイン画面（常に public から配信；dist に含まれないため。リダイレクトは行わず両パスで同じファイルを返す）
const loginIndexPath = path.join(__dirname, 'public', 'login', 'index.html');
app.get('/login', (req, res) => {
    res.sendFile(loginIndexPath);
});
app.get('/login/', (req, res) => {
    res.sendFile(loginIndexPath);
});

// ============================
// Host monitor: systemd ユニットの状態と起動（任意・ADMIN Basic 認証）
// HOST_MONITOR_UNITS=meta-server.service,nginx.service のようにカンマ区切り
// 起動には sudoers で「sudo -n systemctl start <unit>」を許可すること（nginx/README.md 参照）
// ============================
const HOST_MONITOR_UNITS = (process.env.HOST_MONITOR_UNITS || '')
    .split(',')
    .map((s) => s.trim())
    .filter((u) => /^[a-zA-Z0-9_.@-]+$/.test(u));

/**
 * systemctl is-active の結果を返す
 * @param {string} unit
 * @returns {Promise<{ active: boolean, state: string, error?: string }>}
 */
function execSystemctlIsActive(unit) {
    return new Promise((resolve) => {
        execFile('systemctl', ['is-active', unit], { timeout: 15000 }, (err, stdout) => {
            const text = String(stdout || '').trim();
            if (!err) {
                resolve({ active: text === 'active', state: text || 'unknown' });
                return;
            }
            if (err.code === 3) {
                resolve({ active: false, state: text || 'inactive' });
                return;
            }
            resolve({
                active: false,
                state: 'error',
                error: err.message || 'systemctl is-active failed',
            });
        });
    });
}

/**
 * sudo -n systemctl start を実行する（パスワードなし sudo が必要）
 * @param {string} unit
 * @returns {Promise<void>}
 */
function execSystemctlStart(unit) {
    return new Promise((resolve, reject) => {
        execFile(
            'sudo',
            ['-n', 'systemctl', 'start', unit],
            { timeout: 120000 },
            (err, _stdout, stderr) => {
                if (err) {
                    reject(new Error(String(stderr || err.message || 'systemctl start failed')));
                    return;
                }
                resolve();
            }
        );
    });
}

if (HOST_MONITOR_UNITS.length > 0) {
    const hostMonitorHtmlPath = path.join(__dirname, 'public', 'host-monitor.html');
    const hostMonitorRouter = express.Router();
    hostMonitorRouter.use(basicAuth);

    hostMonitorRouter.get('/api/status', async (_req, res) => {
        try {
            const services = await Promise.all(
                HOST_MONITOR_UNITS.map(async (unit) => {
                    const r = await execSystemctlIsActive(unit);
                    return {
                        unit,
                        active: r.active,
                        state: r.state,
                        ...(r.error ? { error: r.error } : {}),
                    };
                })
            );
            res.json({ services });
        } catch (e) {
            res.status(500).json({ error: String(e.message || e) });
        }
    });

    hostMonitorRouter.post('/api/start', async (req, res) => {
        const unit = String(req.body?.unit || '').trim();
        if (!HOST_MONITOR_UNITS.includes(unit)) {
            return res.status(400).json({ error: 'unknown_or_disallowed_unit' });
        }
        try {
            await execSystemctlStart(unit);
            const r = await execSystemctlIsActive(unit);
            res.json({ ok: true, unit, state: r.state, active: r.active });
        } catch (e) {
            res.status(500).json({ ok: false, error: String(e.message || e) });
        }
    });

    hostMonitorRouter.get('/', (_req, res) => {
        res.sendFile(hostMonitorHtmlPath);
    });

    app.use('/host-monitor', hostMonitorRouter);
    console.log(
        `[Host monitor] enabled for units: ${HOST_MONITOR_UNITS.join(', ')} (Basic auth = ADMIN_*)`
    );
}

// Serve admin.html with basic auth (before static files; admin.html is always in public)
app.get('/admin.html', basicAuth, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// ワールド編集は admin に統合済み。setting.html は admin のワールド編集タブへリダイレクト
app.get('/setting.html', basicAuth, (req, res) => {
    res.redirect(302, '/admin.html?panel=world-edit');
});

// Admin metaverse: /admin（末尾スラッシュありも）でBasic認証必須。別セッションとして管理
const sendAdminMetaverseIndex = (req, res) => {
    res.sendFile(path.join(STATIC_DIR, 'index.html'));
};
app.get('/admin', basicAuth, sendAdminMetaverseIndex);
app.get('/admin/', basicAuth, sendAdminMetaverseIndex);

// Apply basic auth to admin API routes
app.use('/admin', basicAuth);

// Serve bootstrap-icons from node_modules (for admin.html etc.)
app.use('/vendor/bootstrap-icons', express.static(path.join(__dirname, 'node_modules/bootstrap-icons/font')));

// /models: アップロード先。本番 S3 モードでは Cookie / Basic 付きのみ配信
const modelsStaticMiddleware = express.static(MODELS_DIR);
app.use('/models', (req, res, next) => {
    if (USE_S3_MODELS && !metaverseModelsAccessAllowed(req)) {
        return res.status(403).type('txt').send('モデルは認証されたメタバースセッションからのみ取得できます');
    }
    modelsStaticMiddleware(req, res, next);
});
app.use('/pdfs', express.static(PDFS_DIR));
app.use('/images', express.static(IMAGES_DIR));
app.use('/env', express.static(ENV_DIR));
if (CHART_FEATURES_ENABLED) {
    app.use('/chart-bgm', express.static(CHART_BGM_DIR, {
        setHeaders: (res, filePath) => {
            if (String(filePath).toLowerCase().endsWith('.mp3')) {
                res.setHeader('Content-Type', 'audio/mpeg');
            }
        }
    }));
}

// admin.html 用の /js, /css は常に public から（dist に含まれないため）
app.use('/js', express.static(path.join(__dirname, 'public', 'js')));
app.use('/css', express.static(path.join(__dirname, 'public', 'css')));

// 静的ファイル（本番時は dist、開発時は public）
app.use(express.static(STATIC_DIR));

// Apply basic auth to admin routes
app.use('/admin.html', basicAuth);
app.use('/admin', basicAuth);

// ============================
// Admin: Metaverse entry token (Basic auth verified admins)
// ============================
const adminTokens = new Map(); // token -> expiry timestamp (ms)
const ADMIN_TOKEN_TTL_MS = 60 * 1000; // 60 seconds

function generateAdminToken() {
    const token = crypto.randomBytes(32).toString('hex');
    adminTokens.set(token, Date.now() + ADMIN_TOKEN_TTL_MS);
    return token;
}

function consumeAdminToken(token) {
    if (!token || typeof token !== 'string') return false;
    const expiry = adminTokens.get(token);
    if (!expiry || Date.now() >= expiry) {
        if (expiry) adminTokens.delete(token);
        return false;
    }
    adminTokens.delete(token);
    return true;
}

/**
 * 管理ワンタイムトークンが未消費かつ有効期限内か（io.use 用、消費はしない）
 * @param {unknown} token
 * @returns {boolean}
 */
function peekAdminToken(token) {
    if (!token || typeof token !== 'string') return false;
    const expiry = adminTokens.get(token);
    return !!(expiry && Date.now() < expiry);
}

if (isSocketGuestDisabled()) {
    io.use((socket, next) => {
        const adminToken = socket.handshake.auth?.adminToken;
        if (peekAdminToken(adminToken)) {
            return next();
        }
        const t = getSocketAuthTokenFromHandshake(socket);
        if (verifySocketAuthToken(t)) {
            return next();
        }
        return next(new Error('AUTH_REQUIRED'));
    });
}

// ============================
// Admin: Log Collection
// ============================
const serverLogs = [];
const MAX_LOGS = 1000;

// Wrap console methods (originals must be captured before wrapping)
const originalLog = console.log;
const originalWarn = console.warn;
const originalError = console.error;

const originalByLevel = { info: originalLog, warn: originalWarn, error: originalError };

function logWithStorage(level, ...args) {
    const timestamp = new Date().toISOString();
    const message = args.join(' ');
    serverLogs.push({ timestamp, level, message });
    if (serverLogs.length > MAX_LOGS) {
        serverLogs.shift();
    }
    try {
        const line = `${timestamp}\t${level}\t${message}\n`;
        const logPath = path.join(STORAGE_PATHS.SERVER_LOG_DIR, 'server.log');
        fs.appendFileSync(logPath, line, 'utf8');
    } catch (e) {
        // If log persistence fails, still continue server operation and print to original console.
    }
    originalByLevel[level](...args);
}

console.log = (...args) => {
    logWithStorage('info', ...args);
};

console.warn = (...args) => {
    logWithStorage('warn', ...args);
};

console.error = (...args) => {
    logWithStorage('error', ...args);
};

// ============================
// Admin: Traffic Statistics
// ============================
const trafficStats = new Map(); // Map<socketId, { bytesReceived, bytesSent, packetsReceived, packetsSent, connectedAt }>
const clientInfo = new Map(); // Map<socketId, { ip, userAgent, browser, os }>

function parseUserAgent(ua) {
    if (!ua || typeof ua !== 'string') return { browser: '-', os: '-' };
    let browser = '-';
    if (ua.includes('Edg/')) browser = 'Edge';
    else if (ua.includes('OPR/') || ua.includes('Opera/')) browser = 'Opera';
    else if (ua.includes('Chrome/')) browser = 'Chrome';
    else if (ua.includes('Firefox/')) browser = 'Firefox';
    else if (ua.includes('Safari/') && !ua.includes('Chrome')) browser = 'Safari';
    let os = '-';
    if (ua.includes('Windows')) os = 'Windows';
    else if (ua.includes('Mac OS') || ua.includes('Macintosh')) os = 'macOS';
    else if (ua.includes('Linux')) os = 'Linux';
    else if (ua.includes('Android')) os = 'Android';
    else if (ua.includes('iPhone')) os = 'iPhone';
    else if (ua.includes('iPad')) os = 'iPad';
    return { browser, os };
}

function updateTrafficStats(socketId, stats) {
    if (!trafficStats.has(socketId)) {
        trafficStats.set(socketId, {
            bytesReceived: 0,
            bytesSent: 0,
            packetsReceived: 0,
            packetsSent: 0,
            connectedAt: Date.now()
        });
    }
    const current = trafficStats.get(socketId);
    if (stats.bytesReceived !== undefined) current.bytesReceived += stats.bytesReceived;
    if (stats.bytesSent !== undefined) current.bytesSent += stats.bytesSent;
    if (stats.packetsReceived !== undefined) current.packetsReceived += stats.packetsReceived;
    if (stats.packetsSent !== undefined) current.packetsSent += stats.packetsSent;
}

function getTotalTrafficStats() {
    let totalBytesReceived = 0;
    let totalBytesSent = 0;
    let totalPacketsReceived = 0;
    let totalPacketsSent = 0;
    
    trafficStats.forEach(stats => {
        totalBytesReceived += stats.bytesReceived;
        totalBytesSent += stats.bytesSent;
        totalPacketsReceived += stats.packetsReceived;
        totalPacketsSent += stats.packetsSent;
    });
    
    return {
        bytesReceived: totalBytesReceived,
        bytesSent: totalBytesSent,
        packetsReceived: totalPacketsReceived,
        packetsSent: totalPacketsSent
    };
}

/** 前回サンプル（通信レート・CPU用）。admin/stats で更新 */
let lastTrafficSample = null;
let lastCpuUsage = null;
let lastCpuTime = null;

/**
 * サーバー負荷メトリクスを取得（CPU・RAM・1秒あたり通信回数・性能劣化指数）
 */
function getServerLoadMetrics() {
    const now = Date.now();
    const traffic = getTotalTrafficStats();
    const totalPackets = traffic.packetsReceived + traffic.packetsSent;

    let commPerSecond = 0;
    if (lastTrafficSample && lastTrafficSample.ts < now) {
        const elapsedSec = (now - lastTrafficSample.ts) / 1000;
        if (elapsedSec > 0) {
            commPerSecond = (totalPackets - lastTrafficSample.totalPackets) / elapsedSec;
        }
    }
    lastTrafficSample = { totalPackets, packetsReceived: traffic.packetsReceived, packetsSent: traffic.packetsSent, ts: now };

    /** Node プロセスが使った CPU 時間を「全コア合計に対する%」に換算（タスクマネージャーと一致） */
    let cpuUsagePercent = null;
    const numCpus = os.cpus().length;
    if (lastCpuTime !== null && lastCpuUsage !== null && numCpus > 0) {
        const elapsedSec = (now - lastCpuTime) / 1000;
        if (elapsedSec > 0) {
            const delta = process.cpuUsage(lastCpuUsage);
            const oneCorePercent = ((delta.user + delta.system) / 1e6 / elapsedSec) * 100;
            cpuUsagePercent = oneCorePercent / numCpus;
        }
    }
    lastCpuUsage = process.cpuUsage();
    lastCpuTime = now;

    const totalMem = os.totalmem();
    const usedMem = totalMem - os.freemem();
    const ramUsagePercent = totalMem > 0 ? (usedMem / totalMem) * 100 : null;

    const FPS_BASELINE = 30;
    const degradationIndex = commPerSecond / FPS_BASELINE;

    return { cpuUsagePercent, ramUsagePercent, commPerSecond, degradationIndex };
}

// ============================
// Admin: Chat Log Collection
// ============================
const chatLogs = new Map(); // Map<roomId, Array<{timestamp, senderName, message}>>
const MAX_CHAT_LOGS_PER_ROOM = 500;

function addChatLog(roomId, senderName, message) {
    if (!chatLogs.has(roomId)) {
        chatLogs.set(roomId, []);
    }
    const logs = chatLogs.get(roomId);
    logs.push({
        timestamp: Date.now(),
        senderName: senderName,
        message: message
    });
    // Keep only last MAX_CHAT_LOGS_PER_ROOM entries
    if (logs.length > MAX_CHAT_LOGS_PER_ROOM) {
        logs.shift();
    }
}

function getChatLogs(roomId, limit = 100) {
    if (!chatLogs.has(roomId)) {
        return [];
    }
    const logs = chatLogs.get(roomId);
    return logs.slice(-limit);
}

function getAllChatLogs(limit = 100) {
    const allLogs = [];
    chatLogs.forEach((logs, roomId) => {
        const roomLogs = logs.slice(-limit);
        roomLogs.forEach(log => {
            allLogs.push({
                ...log,
                roomId: roomId
            });
        });
    });
    // Sort by timestamp
    allLogs.sort((a, b) => a.timestamp - b.timestamp);
    return allLogs.slice(-limit);
}

// ============================
// Admin: VC Port Tracking
// ============================
function getVCPortInfo() {
    const ports = new Set();
    const portDetails = [];
    
    vcPeers.forEach((peer, socketId) => {
        if (peer.sendTransport) {
            peer.sendTransport.iceCandidates.forEach(candidate => {
                if (candidate.port) {
                    ports.add(candidate.port);
                    portDetails.push({
                        socketId,
                        roomId: peer.roomId,
                        direction: 'send',
                        protocol: candidate.protocol,
                        ip: candidate.ip,
                        port: candidate.port,
                        type: candidate.type
                    });
                }
            });
        }
        if (peer.recvTransport) {
            peer.recvTransport.iceCandidates.forEach(candidate => {
                if (candidate.port) {
                    ports.add(candidate.port);
                    portDetails.push({
                        socketId,
                        roomId: peer.roomId,
                        direction: 'recv',
                        protocol: candidate.protocol,
                        ip: candidate.ip,
                        port: candidate.port,
                        type: candidate.type
                    });
                }
            });
        }
    });
    
    return {
        uniquePorts: Array.from(ports).sort((a, b) => a - b),
        portDetails
    };
}

function getPdfVCPortInfo() {
    const ports = new Set();
    const portDetails = [];

    pdfVcPeers.forEach((peer, socketId) => {
        if (peer.sendTransport) {
            peer.sendTransport.iceCandidates.forEach(candidate => {
                if (candidate.port) {
                    ports.add(candidate.port);
                    portDetails.push({
                        socketId,
                        roomId: peer.pdfRoomId,
                        direction: 'send',
                        protocol: candidate.protocol,
                        ip: candidate.ip,
                        port: candidate.port,
                        type: candidate.type
                    });
                }
            });
        }
        if (peer.recvTransport) {
            peer.recvTransport.iceCandidates.forEach(candidate => {
                if (candidate.port) {
                    ports.add(candidate.port);
                    portDetails.push({
                        socketId,
                        roomId: peer.pdfRoomId,
                        direction: 'recv',
                        protocol: candidate.protocol,
                        ip: candidate.ip,
                        port: candidate.port,
                        type: candidate.type
                    });
                }
            });
        }
    });

    return {
        uniquePorts: Array.from(ports).sort((a, b) => a - b),
        portDetails
    };
}

function getVideoVCPortInfo() {
    const ports = new Set();
    const portDetails = [];

    videoVcPeers.forEach((peer, socketId) => {
        if (peer.sendTransport) {
            peer.sendTransport.iceCandidates.forEach(candidate => {
                if (candidate.port) {
                    ports.add(candidate.port);
                    portDetails.push({
                        socketId,
                        roomId: peer.roomId,
                        direction: 'send',
                        protocol: candidate.protocol,
                        ip: candidate.ip,
                        port: candidate.port,
                        type: candidate.type
                    });
                }
            });
        }
        if (peer.recvTransport) {
            peer.recvTransport.iceCandidates.forEach(candidate => {
                if (candidate.port) {
                    ports.add(candidate.port);
                    portDetails.push({
                        socketId,
                        roomId: peer.roomId,
                        direction: 'recv',
                        protocol: candidate.protocol,
                        ip: candidate.ip,
                        port: candidate.port,
                        type: candidate.type
                    });
                }
            });
        }
    });

    return {
        uniquePorts: Array.from(ports).sort((a, b) => a - b),
        portDetails
    };
}

// ============================
// mediasoup Worker Initialization
// ============================
async function createWorkers() {
    const numWorkers = Math.min(os.cpus().length, 4); // Max 4 workers
    console.log(`Creating ${numWorkers} mediasoup workers...`);
    
    for (let i = 0; i < numWorkers; i++) {
        const worker = await mediasoup.createWorker({
            ...mediasoupConfig.worker,
        });
        
        worker.on('died', () => {
            console.error(`mediasoup worker ${worker.pid} died, exiting in 2s...`);
            setTimeout(() => process.exit(1), 2000);
        });
        
        workers.push(worker);
        console.log(`mediasoup worker ${i + 1} created [pid: ${worker.pid}]`);
    }
}

async function createPdfWorkers() {
    const numWorkers = Math.min(os.cpus().length, 4);
    console.log(`Creating ${numWorkers} PDF VC mediasoup workers (ports ${PDF_VC_RTC_MIN_PORT}-${PDF_VC_RTC_MAX_PORT})...`);
    for (let i = 0; i < numWorkers; i++) {
        const worker = await mediasoup.createWorker({
            ...pdfVcMediasoupConfig.worker,
        });
        worker.on('died', () => {
            console.error(`[PDF VC] mediasoup worker ${worker.pid} died, exiting in 2s...`);
            setTimeout(() => process.exit(1), 2000);
        });
        pdfWorkers.push(worker);
        console.log(`[PDF VC] worker ${i + 1} created [pid: ${worker.pid}]`);
    }
}

function getNextPdfWorker() {
    const w = pdfWorkers[nextPdfWorkerIndex];
    nextPdfWorkerIndex = (nextPdfWorkerIndex + 1) % pdfWorkers.length;
    return w;
}

async function createVideoVcWorkers() {
    const numWorkers = Math.min(os.cpus().length, 4);
    console.log(`Creating ${numWorkers} Video VC mediasoup workers (ports ${VIDEO_VC_RTC_MIN_PORT}-${VIDEO_VC_RTC_MAX_PORT})...`);
    for (let i = 0; i < numWorkers; i++) {
        const worker = await mediasoup.createWorker({
            ...videoVcMediasoupConfig.worker,
        });
        worker.on('died', () => {
            console.error(`[Video VC] mediasoup worker ${worker.pid} died, exiting in 2s...`);
            setTimeout(() => process.exit(1), 2000);
        });
        videoVcWorkers.push(worker);
        console.log(`[Video VC] worker ${i + 1} created [pid: ${worker.pid}]`);
    }
}

function getNextVideoVcWorker() {
    const w = videoVcWorkers[nextVideoVcWorkerIndex];
    nextVideoVcWorkerIndex = (nextVideoVcWorkerIndex + 1) % videoVcWorkers.length;
    return w;
}

function getNextWorker() {
    const worker = workers[nextWorkerIndex];
    nextWorkerIndex = (nextWorkerIndex + 1) % workers.length;
    return worker;
}

// Get or create mediasoup Router for a room
async function getOrCreateVCRouter(roomId) {
    if (!vcRouters.has(roomId)) {
        if (vcRouters.size >= VC_MAX_MEDIASOUP_ROUTERS) {
            throw new Error('room_limit');
        }
        const worker = getNextWorker();
        const router = await worker.createRouter({
            mediaCodecs: mediasoupConfig.router.mediaCodecs,
        });
        vcRouters.set(roomId, router);
        console.log(`[VC] Created Router for room: ${roomId}`);
    }
    return vcRouters.get(roomId);
}

async function getOrCreatePdfVCRouter(pdfRoomId) {
    if (!pdfVcRouters.has(pdfRoomId)) {
        if (pdfVcRouters.size >= VC_MAX_MEDIASOUP_ROUTERS) {
            throw new Error('room_limit');
        }
        const worker = getNextPdfWorker();
        const router = await worker.createRouter({
            mediaCodecs: pdfVcMediasoupConfig.router.mediaCodecs,
        });
        pdfVcRouters.set(pdfRoomId, router);
        console.log(`[PDF VC] Created Router for pdf room: ${pdfRoomId}`);
    }
    return pdfVcRouters.get(pdfRoomId);
}

async function getOrCreateVideoVCRouter(roomId) {
    if (!videoVcRouters.has(roomId)) {
        if (videoVcRouters.size >= VC_MAX_MEDIASOUP_ROUTERS) {
            throw new Error('room_limit');
        }
        const worker = getNextVideoVcWorker();
        const router = await worker.createRouter({
            mediaCodecs: videoVcMediasoupConfig.router.mediaCodecs,
        });
        videoVcRouters.set(roomId, router);
        console.log(`[Video VC] Created Router for room: ${roomId}`);
    }
    return videoVcRouters.get(roomId);
}

// Room-based player state storage
// roomStates: Map<roomId, { players: Map<socketId, playerState> }>
const roomStates = new Map();

const VALID_PLAYER_ANIM_STATES = new Set(['idle', 'walk', 'dash', 'jump']);

/** @param {unknown} s */
function normalizePlayerAnimState(s) {
    return typeof s === 'string' && VALID_PLAYER_ANIM_STATES.has(s) ? s : 'idle';
}

// Per-player ping (socketId -> { pingMs, reportedAt })
const playerPings = new Map();
const PING_STALE_MS = 15000;

// Helper function to get or create room state
function getRoomState(roomId) {
    if (!roomStates.has(roomId)) {
        roomStates.set(roomId, {
            players: new Map(),
            aircraft: {
                pilots: new Map(),
                poses: new Map()
            }
        });
        console.log(`Created new room: ${roomId}`);
    }
    const rs = roomStates.get(roomId);
    if (!rs.aircraft) {
        rs.aircraft = { pilots: new Map(), poses: new Map() };
    }
    return rs;
}

// VC: Cleanup peer resources
async function cleanupVCPeer(socketId) {
    const peer = vcPeers.get(socketId);
    if (!peer) return;
    
    console.log(`[VC] Cleaning up peer: ${socketId}`);
    
    // Notify others about producer closure BEFORE closing
    const producerIds = Array.from(peer.producers.keys());
    if (peer.roomId && producerIds.length > 0) {
        for (const producerId of producerIds) {
            io.to(peer.roomId).emit('vc-producer-closed', { producerId });
        }
    }
    
    // Close all producers
    for (const [producerId, producer] of peer.producers) {
        try {
            producer.close();
        } catch (error) {
            console.error(`[VC] Error closing producer ${producerId}:`, error);
        }
    }
    
    // Close all consumers
    for (const [consumerId, consumer] of peer.consumers) {
        try {
            consumer.close();
        } catch (error) {
            console.error(`[VC] Error closing consumer ${consumerId}:`, error);
        }
    }
    
    // Close transports
    if (peer.sendTransport) {
        try {
            peer.sendTransport.close();
        } catch (error) {
            console.error(`[VC] Error closing send transport:`, error);
        }
    }
    if (peer.recvTransport) {
        try {
            peer.recvTransport.close();
        } catch (error) {
            console.error(`[VC] Error closing recv transport:`, error);
        }
    }
    
    vcPeers.delete(socketId);
}

// PDF VC: Cleanup peer resources
async function cleanupPdfVCPeer(socketId) {
    const peer = pdfVcPeers.get(socketId);
    if (!peer) return;

    console.log(`[PDF VC] Cleaning up peer: ${socketId}`);

    const producerIds = Array.from(peer.producers.keys());
    if (peer.pdfRoomId && producerIds.length > 0) {
        for (const producerId of producerIds) {
            io.to(peer.pdfRoomId).emit('pdf-vc-producer-closed', { producerId });
        }
    }

    for (const [producerId, producer] of peer.producers) {
        try { producer.close(); } catch (e) { console.error(`[PDF VC] Error closing producer ${producerId}:`, e); }
    }
    for (const [consumerId, consumer] of peer.consumers) {
        try { consumer.close(); } catch (e) { console.error(`[PDF VC] Error closing consumer ${consumerId}:`, e); }
    }
    if (peer.sendTransport) {
        try { peer.sendTransport.close(); } catch (e) { console.error(`[PDF VC] Error closing send transport:`, e); }
    }
    if (peer.recvTransport) {
        try { peer.recvTransport.close(); } catch (e) { console.error(`[PDF VC] Error closing recv transport:`, e); }
    }

    pdfVcPeers.delete(socketId);
}

// Video VC: Cleanup peer resources
async function cleanupVideoVCPeer(socketId) {
    const peer = videoVcPeers.get(socketId);
    if (!peer) return;

    console.log(`[Video VC] Cleaning up peer: ${socketId}`);

    const producerIds = Array.from(peer.producers.keys());
    if (peer.roomId && producerIds.length > 0) {
        for (const producerId of producerIds) {
            io.to(peer.roomId).emit('video-vc-producer-closed', { producerId });
        }
    }

    for (const [producerId, producer] of peer.producers) {
        try { producer.close(); } catch (e) { console.error(`[Video VC] Error closing producer ${producerId}:`, e); }
    }
    for (const [consumerId, consumer] of peer.consumers) {
        try { consumer.close(); } catch (e) { console.error(`[Video VC] Error closing consumer ${consumerId}:`, e); }
    }
    if (peer.sendTransport) {
        try { peer.sendTransport.close(); } catch (e) { console.error(`[Video VC] Error closing send transport:`, e); }
    }
    if (peer.recvTransport) {
        try { peer.recvTransport.close(); } catch (e) { console.error(`[Video VC] Error closing recv transport:`, e); }
    }

    videoVcPeers.delete(socketId);
}

// Default room for initial connections
const DEFAULT_ROOM = 'lobby';

/** テレポーター利用権限: access とユーザーの実効ロールで利用可否を判定する */
function canUseTeleporter(access, effectiveRole) {
    const role = effectiveRole || 'guest';
    if (access === 'public') return true;
    if (access === 'student+') return role === 'student' || role === 'teacher' || role === 'admin';
    if (access === 'teacher+') return role === 'teacher' || role === 'admin';
    if (access === 'admin') return role === 'admin';
    console.warn(`[teleporter] unknown access value (${JSON.stringify(access)}) — denied`);
    return false;
}

function getPlayerDisplayName(player) {
    // isAdmin is set at connection and stored in player to avoid socket lookup issues
    return (player.isAdmin === true) ? 'admin' : (player.username || 'Guest');
}

/** 太鼓マルチ: worldId+groupId → { slotCount, parts, names, ready, inGame, chartId, startAt, finished } */
const taikoMpRooms = new Map();

function taikoMpRoomKey(worldId, groupId) {
    return `${worldId}\0${groupId}`;
}

/**
 * 切断時に太鼓マルチのパート割当を解除し状態を通知する
 * @param {import('socket.io').Server} ioSrv
 * @param {string} socketId
 */
function cleanupTaikoMpOnDisconnect(ioSrv, socketId) {
    for (const [k, st] of taikoMpRooms) {
        let changed = false;
        for (const [pi, sid] of [...st.parts.entries()]) {
            if (sid === socketId) {
                // 演奏中に切断した場合は、そのパートを0点で終了扱いにして進行不能を避ける
                if (st.inGame && st.finished && !st.finished.has(pi)) {
                    const name = st.names?.get(pi) || `P${pi}`;
                    st.finished.set(pi, { score: 0, name });
                }
                st.parts.delete(pi);
                if (st.names) st.names.delete(pi);
                if (st.ready) st.ready.delete(pi);
                changed = true;
            }
        }
        if (changed) {
            const idx = k.indexOf('\0');
            const worldId = idx >= 0 ? k.slice(0, idx) : k;
            const groupId = idx >= 0 ? k.slice(idx + 1) : '';
            const parts = {};
            for (let i = 1; i <= st.slotCount; i++) {
                parts[i] = { taken: st.parts.has(i), name: st.names?.get(i) || '', ready: !!st.ready?.get(i) };
            }
            ioSrv.to(`taiko-mp:${worldId}:${groupId}`).emit('taiko-mp-state', { slotCount: st.slotCount, parts, inGame: !!st.inGame });
        }
    }
}

// Socket.io connection handling
io.on('connection', (socket) => {
    // Verify admin token and user role if provided
    const adminToken = socket.handshake.auth?.adminToken;
    if (consumeAdminToken(adminToken)) {
        socket.data.isAdmin = true;
        socket.data.role = 'admin';
        console.log(`Player connected as admin: ${socket.id}`);
    } else {
        socket.data.isAdmin = false;
        const verified = verifySocketAuthToken(getSocketAuthTokenFromHandshake(socket));
        socket.data.role = verified ? verified.role : undefined; // guest は undefined
        console.log(`Player connected: ${socket.id}`);
    }

    // Initialize traffic stats
    trafficStats.set(socket.id, {
        bytesReceived: 0,
        bytesSent: 0,
        packetsReceived: 0,
        packetsSent: 0,
        connectedAt: Date.now()
    });

    // Store client info (IP, User-Agent) for admin player info
    const forwarded = socket.handshake.headers['x-forwarded-for'];
    const ip = (typeof forwarded === 'string' ? forwarded.split(',')[0].trim() : null) || socket.handshake.address || '-';
    const ua = socket.handshake.headers['user-agent'] || '';
    const { browser, os } = parseUserAgent(ua);
    clientInfo.set(socket.id, { ip, userAgent: ua, browser, os });
    socket.connectedAt = Date.now();

    // Track traffic (approximate via socket events)
    socket.on('player-update', () => {
        updateTrafficStats(socket.id, { bytesSent: 100, packetsSent: 1 });
    });
    
    socket.on('chat-message', () => {
        updateTrafficStats(socket.id, { bytesSent: 50, packetsSent: 1 });
    });

    // Join default room
    const currentRoom = DEFAULT_ROOM;
    socket.join(currentRoom);
    socket.data.currentRoom = currentRoom;
    socket.data.effectivePerfTier = 'high';

    // Initialize player data in room state
    const roomState = getRoomState(currentRoom);
    const initialPlayerState = {
        id: socket.id,
        username: 'Guest', // Will be updated when client sends username
        isAdmin: !!socket.data.isAdmin,
        position: { x: 0, y: 2, z: 0 },
        rotation: { x: 0, y: 0, z: 0 }, // Euler angles
        quaternion: { x: 0, y: 0, z: 0, w: 1 },
        world: currentRoom,
        timestamp: 0, // Will be updated on first player-update
        adminInvisible: false,
        animState: 'idle',
        serverLowAssistPrev: null,
        serverLowAssistAt: Date.now(),
        pilotingAircraftId: null
    };
    roomState.players.set(socket.id, initialPlayerState);
    setPhysicsAssistGrace(socket);

    const aircraftSnap = buildAircraftSnapshotList(roomState);
    if (aircraftSnap.length > 0) {
        socket.emit('aircraft-initial', { aircraft: aircraftSnap });
    }

    // Send current players in this room to the new player (with displayName for admin)
    const currentPlayers = Array.from(roomState.players.values()).map(p => ({
        ...p,
        displayName: getPlayerDisplayName(p)
    }));
    socket.emit('current-players', currentPlayers);

    // Notify other players in room about new player
    socket.to(currentRoom).emit('player-joined', initialPlayerState);
    
    console.log(`Player ${socket.id} joined room: ${currentRoom} (${roomState.players.size} players)`);

    // Ping/Pong for latency measurement
    socket.on('ping', (data, callback) => {
        if (typeof callback === 'function') {
            callback({ ts: data?.ts });
        }
    });

    // Client reports RTT + client perf (FPS サンプル・LoAF 等)
    socket.on('report-ping', (payload) => {
        const pingMs = payload && typeof payload.pingMs === 'number' ? payload.pingMs : NaN;
        if (!(pingMs >= 0 && pingMs < 10000)) return;

        const fpsSample = payload.fpsSample != null && typeof payload.fpsSample === 'number' && Number.isFinite(payload.fpsSample)
            ? Math.max(0, Math.min(1000, Math.floor(payload.fpsSample)))
            : null;
        let perfTier = payload.perfTier;
        if (perfTier !== 'low' && perfTier !== 'medium' && perfTier !== 'high') {
            perfTier = fpsSample != null
                ? (fpsSample <= 25 ? 'low' : fpsSample <= 45 ? 'medium' : 'high')
                : 'high';
        }
        const loafCount = payload.loafCount != null && typeof payload.loafCount === 'number' && Number.isFinite(payload.loafCount)
            ? Math.max(0, Math.floor(payload.loafCount)) : 0;
        const longtaskCount = payload.longtaskCount != null && typeof payload.longtaskCount === 'number' && Number.isFinite(payload.longtaskCount)
            ? Math.max(0, Math.floor(payload.longtaskCount)) : 0;
        const perfSampleAt = payload.perfSampleAt != null && typeof payload.perfSampleAt === 'number' && Number.isFinite(payload.perfSampleAt)
            ? payload.perfSampleAt : null;

        const roomState = getRoomState(socket.data.currentRoom);
        const pl = roomState?.players?.get(socket.id);
        const isAdminPlayer = !!(socket.data.isAdmin || pl?.isAdmin);
        const effectiveTier = isAdminPlayer ? 'high' : perfTier;

        socket.data.effectivePerfTier = effectiveTier;

        playerPings.set(socket.id, {
            pingMs,
            reportedAt: Date.now(),
            fpsSample,
            perfTier,
            effectiveTier,
            loafCount,
            longtaskCount,
            perfSampleAt
        });

        const uname = pl?.username || 'Guest';
        console.log(`[perf] ${socket.id.slice(0, 8)}… ${uname} ping=${pingMs}ms fps=${fpsSample ?? '-'} tier=${perfTier} eff=${effectiveTier} loaf=${loafCount} longtask=${longtaskCount}`);
    });

    if (CHART_FEATURES_ENABLED) {
    // 太鼓BGM同期用: サーバ時刻の取得（RTT推定はクライアント側）
    socket.on('taiko-time-sync', (data, callback) => {
        if (typeof callback !== 'function') return;
        callback({ serverNow: Date.now() });
    });

    // 太鼓ヒット音: ソロ時は現在ワールド(room)全体、マルチ時は該当 taiko-mp ルームへ共有
    socket.on('taiko-hit', ({ multiplayer, worldId, groupId, type }) => {
        const hitType = type === 'ka' ? 'ka' : 'don';
        if (multiplayer && worldId && groupId) {
            io.to(`taiko-mp:${worldId}:${groupId}`).emit('taiko-hit', {
                type: hitType,
                multiplayer: true,
                worldId,
                groupId,
                from: socket.id
            });
            return;
        }
        const currentRoom = socket.data.currentRoom;
        if (!currentRoom) return;
        io.to(currentRoom).emit('taiko-hit', {
            type: hitType,
            multiplayer: false,
            worldId: currentRoom,
            from: socket.id
        });
    });

    socket.on('taiko-mp-join', ({ worldId, groupId, slotCount, chartId }, cb) => {
        if (!worldId || !groupId || typeof slotCount !== 'number') {
            if (typeof cb === 'function') cb({ ok: false });
            return;
        }
        const sc = Math.min(3, Math.max(1, Math.floor(slotCount)));
        const k = taikoMpRoomKey(worldId, groupId);
        const roomName = `taiko-mp:${worldId}:${groupId}`;
        socket.join(roomName);
        for (const st of taikoMpRooms.values()) {
            for (const [pi, sid] of [...st.parts.entries()]) {
                if (sid === socket.id) {
                    // 以前取っていたパートを完全に解放（names/ready/finished も同期対象から除外）
                    st.parts.delete(pi);
                    st.names.delete(pi);
                    st.ready.delete(pi);
                    st.finished.delete(pi);
                }
            }
        }
        let st = taikoMpRooms.get(k);
        if (!st || st.slotCount !== sc) {
            st = { slotCount: sc, parts: new Map(), names: new Map(), ready: new Map(), inGame: false, chartId: null, startAt: null, finished: new Map() };
            taikoMpRooms.set(k, st);
        }
        if (typeof chartId === 'string' && chartId.trim()) {
            st.chartId = chartId.trim();
        }
        const parts = {};
        for (let i = 1; i <= st.slotCount; i++) {
            parts[i] = { taken: st.parts.has(i), name: st.names.get(i) || '', ready: !!st.ready.get(i) };
        }
        io.to(roomName).emit('taiko-mp-state', { slotCount: st.slotCount, parts, inGame: !!st.inGame, startAt: st.startAt });
        if (typeof cb === 'function') cb({ ok: true });
    });

    socket.on('taiko-mp-leave', ({ worldId, groupId }) => {
        if (!worldId || !groupId) return;
        socket.leave(`taiko-mp:${worldId}:${groupId}`);
        const k = taikoMpRoomKey(worldId, groupId);
        const st = taikoMpRooms.get(k);
        if (st) {
            for (const [pi, sid] of [...st.parts.entries()]) {
                if (sid === socket.id) {
                    // 演奏中に離脱した場合は、そのパートを0点で終了扱いにして進行不能を避ける
                    if (st.inGame && !st.finished.has(pi)) {
                        const name = st.names.get(pi) || `P${pi}`;
                        st.finished.set(pi, { score: 0, name });
                    }
                    st.parts.delete(pi);
                    st.names.delete(pi);
                    st.ready.delete(pi);
                }
            }
        }
        const parts = {};
        if (st) {
            for (let i = 1; i <= st.slotCount; i++) {
                parts[i] = { taken: st.parts.has(i), name: st.names.get(i) || '', ready: !!st.ready.get(i) };
            }
            io.to(`taiko-mp:${worldId}:${groupId}`).emit('taiko-mp-state', { slotCount: st.slotCount, parts, inGame: !!st.inGame, startAt: st.startAt });
        }
    });

    socket.on('taiko-mp-claim-part', ({ worldId, groupId, partIndex }, cb) => {
        const k = taikoMpRoomKey(worldId, groupId);
        const st = taikoMpRooms.get(k);
        if (!st) {
            if (typeof cb === 'function') cb({ ok: false, error: 'room' });
            return;
        }
        if (st.inGame) {
            if (typeof cb === 'function') cb({ ok: false, error: 'in_game' });
            return;
        }
        const p = Number(partIndex);
        if (!Number.isInteger(p) || p < 1 || p > st.slotCount) {
            if (typeof cb === 'function') cb({ ok: false, error: 'part' });
            return;
        }
        for (const [pi, sid] of [...st.parts.entries()]) {
            if (sid === socket.id) {
                st.parts.delete(pi);
                st.names.delete(pi);
                st.ready.delete(pi);
                st.finished.delete(pi);
            }
        }
        const cur = st.parts.get(p);
        if (cur && cur !== socket.id) {
            if (typeof cb === 'function') cb({ ok: false, error: 'taken' });
            return;
        }
        st.parts.set(p, socket.id);
        st.ready.set(p, false);
        const parts = {};
        for (let i = 1; i <= st.slotCount; i++) {
            parts[i] = { taken: st.parts.has(i), name: st.names.get(i) || '', ready: !!st.ready.get(i) };
        }
        const roomName = `taiko-mp:${worldId}:${groupId}`;
        st.startAt = null;
        io.to(roomName).emit('taiko-mp-state', { slotCount: st.slotCount, parts, inGame: !!st.inGame, startAt: st.startAt });
        if (typeof cb === 'function') cb({ ok: true });
    });

    socket.on('taiko-mp-ready', ({ worldId, groupId, partIndex, ready }, cb) => {
        const k = taikoMpRoomKey(worldId, groupId);
        const st = taikoMpRooms.get(k);
        if (!st) {
            if (typeof cb === 'function') cb({ ok: false, error: 'room' });
            return;
        }
        const p = Number(partIndex);
        if (!Number.isInteger(p) || p < 1 || p > st.slotCount) {
            if (typeof cb === 'function') cb({ ok: false, error: 'part' });
            return;
        }
        const owner = st.parts.get(p);
        if (!owner || owner !== socket.id) {
            if (typeof cb === 'function') cb({ ok: false, error: 'not_owner' });
            return;
        }
        st.ready.set(p, !!ready);

        const parts = {};
        for (let i = 1; i <= st.slotCount; i++) {
            parts[i] = { taken: st.parts.has(i), name: st.names.get(i) || '', ready: !!st.ready.get(i) };
        }

        const roomName = `taiko-mp:${worldId}:${groupId}`;
        const allTaken = st.parts.size >= st.slotCount;
        const allReady = allTaken && [...Array(st.slotCount)].every((_, idx) => !!st.ready.get(idx + 1));

        if (!st.inGame && allReady && st.chartId) {
            st.inGame = true;
            st.finished.clear();
            st.startAt = Date.now() + 4000;
            for (const [pi, sid] of st.parts.entries()) {
                io.to(sid).emit('taiko-mp-sync-start', { startAt: st.startAt, chartId: st.chartId, partIndex: pi });
            }
        }

        io.to(roomName).emit('taiko-mp-state', { slotCount: st.slotCount, parts, inGame: !!st.inGame, startAt: st.startAt });
        if (typeof cb === 'function') cb({ ok: true });
    });

    socket.on('taiko-mp-set-name', ({ worldId, groupId, partIndex, name }, cb) => {
        const k = taikoMpRoomKey(worldId, groupId);
        const st = taikoMpRooms.get(k);
        if (!st) {
            if (typeof cb === 'function') cb({ ok: false });
            return;
        }
        const p = Number(partIndex);
        if (!Number.isInteger(p) || p < 1 || p > st.slotCount) {
            if (typeof cb === 'function') cb({ ok: false });
            return;
        }
        const owner = st.parts.get(p);
        if (!owner || owner !== socket.id) {
            if (typeof cb === 'function') cb({ ok: false, error: 'not_owner' });
            return;
        }
        const s = String(name || '').trim().slice(0, 20);
        st.names.set(p, s || `P${p}`);
        const parts = {};
        for (let i = 1; i <= st.slotCount; i++) {
            parts[i] = { taken: st.parts.has(i), name: st.names.get(i) || '', ready: !!st.ready.get(i) };
        }
        io.to(`taiko-mp:${worldId}:${groupId}`).emit('taiko-mp-state', { slotCount: st.slotCount, parts, inGame: !!st.inGame, startAt: st.startAt });
        if (typeof cb === 'function') cb({ ok: true });
    });

    socket.on('taiko-mp-finish', ({ worldId, groupId, partIndex, score }, cb) => {
        const k = taikoMpRoomKey(worldId, groupId);
        const st = taikoMpRooms.get(k);
        if (!st || !st.inGame) {
            if (typeof cb === 'function') cb({ ok: false });
            return;
        }
        const p = Number(partIndex);
        if (!Number.isInteger(p) || p < 1 || p > st.slotCount) {
            if (typeof cb === 'function') cb({ ok: false });
            return;
        }
        const owner = st.parts.get(p);
        if (!owner || owner !== socket.id) {
            if (typeof cb === 'function') cb({ ok: false, error: 'not_owner' });
            return;
        }
        const sc = Math.max(0, Math.floor(Number(score) || 0));
        st.finished.set(p, { score: sc, name: st.names.get(p) || `P${p}` });
        const done = st.finished.size >= st.slotCount;
        if (done) {
            const players = [];
            let totalScore = 0;
            for (let i = 1; i <= st.slotCount; i++) {
                const v = st.finished.get(i) || { score: 0, name: st.names.get(i) || `P${i}` };
                totalScore += v.score;
                players.push({ partIndex: i, name: v.name, score: v.score });
            }
            io.to(`taiko-mp:${worldId}:${groupId}`).emit('taiko-mp-results', {
                chartId: st.chartId,
                totalScore,
                players
            });
            st.inGame = false;
            st.chartId = null;
            st.parts.clear();
            st.names.clear();
            st.finished.clear();
            const parts = {};
            for (let i = 1; i <= st.slotCount; i++) {
                parts[i] = { taken: false, name: '' };
            }
            io.to(`taiko-mp:${worldId}:${groupId}`).emit('taiko-mp-state', { slotCount: st.slotCount, parts, inGame: !!st.inGame });
        }
        if (typeof cb === 'function') cb({ ok: true });
    });

    } // CHART_FEATURES_ENABLED: 太鼓ソケット

    // Handle username setting
    socket.on('set-username', (username) => {
        const currentRoom = socket.data.currentRoom;
        if (!currentRoom) return;

        const roomState = getRoomState(currentRoom);
        const player = roomState.players.get(socket.id);

        if (!player || !username || username.trim().length === 0) return;

        const trimmed = username.trim();
        // "admin" は管理者トークン検証済みのみ許可。拒否時はエラーで切断
        if (trimmed.toLowerCase() === 'admin' && !socket.data.isAdmin) {
            socket.emit('username-rejected', {
                error: 'admin_reserved',
                message: '「admin」は管理者専用です。管理者は /admin からBasic認証で入室してください。'
            });
            socket.disconnect(true);
            console.log(`Player ${socket.id} attempted admin name, disconnected`);
            return;
        }

        player.username = trimmed;
        console.log(`Player ${socket.id} set username to: ${player.username}`);

        const info = clientInfo.get(socket.id);
        if (info) {
            insertSession({
                username: trimmed,
                loginTime: socket.connectedAt || Date.now(),
                ip: info.ip || '-',
                browser: info.browser || '-',
                os: info.os || '-'
            });
        }

        const displayName = player.isAdmin ? 'admin' : player.username;

        // Notify other players about the username update
        socket.to(currentRoom).emit('player-username-updated', {
            id: socket.id,
            username: player.username,
            displayName
        });
    });

    // Handle player position updates (Ingress layer with timestamp verification)
    socket.on('player-update', (data) => {
        const currentRoom = socket.data.currentRoom;
        if (!currentRoom) {
            console.warn(`Player ${socket.id} sent update but has no room`);
            return;
        }

        const roomState = getRoomState(currentRoom);
        const player = roomState.players.get(socket.id);
        
        if (!player) {
            console.warn(`Player ${socket.id} not found in room ${currentRoom}`);
            return;
        }

        // Timestamp verification - discard old data
        const incomingTimestamp = data.timestamp || 0;
        if (incomingTimestamp <= player.timestamp) {
            // Discard outdated data
            return;
        }

        // Update player state with latest data
        if (data.position) {
            const pos = { ...data.position };
            const posOk = [pos.x, pos.y, pos.z].every((n) => typeof n === 'number' && Number.isFinite(n));
            if (posOk) {
                const graceUntil = socket.data.physicsAssistGraceUntil;
                const inGrace = typeof graceUntil === 'number' && Date.now() < graceUntil;
                const worldsData = readWorlds();
                const wcfg = worldsData[currentRoom];
                const effTier = socket.data.effectivePerfTier || 'high';

                const skipAssist = !!player.pilotingAircraftId;

                if (!player.isAdmin && !inGrace && effTier === 'low' && !skipAssist) {
                    const low = applyLowTierPositionChecks(
                        pos,
                        player.serverLowAssistPrev,
                        typeof player.serverLowAssistAt === 'number' ? player.serverLowAssistAt : Date.now(),
                        wcfg
                    );
                    pos.x = low.pos.x;
                    pos.y = low.pos.y;
                    pos.z = low.pos.z;
                    if (low.usedFullCorrection) {
                        socket.emit('physics-position-correction', { x: pos.x, y: pos.y, z: pos.z });
                    }
                }

                if (!player.isAdmin && !inGrace && !skipAssist) {
                    const clamped = clampPlayerFeetYForWorld(wcfg, pos.y);
                    if (clamped.changed) {
                        pos.y = clamped.y;
                        socket.emit('physics-y-correction', { y: pos.y });
                    }
                }

                if (!player.isAdmin) {
                    player.serverLowAssistPrev = { x: pos.x, y: pos.y, z: pos.z };
                    player.serverLowAssistAt = Date.now();
                }

                player.position = pos;
            }
        }
        if (data.rotation) {
            player.rotation = data.rotation;
        }
        if (data.quaternion) {
            player.quaternion = data.quaternion;
        }
        if (data.adminInvisible !== undefined) {
            player.adminInvisible = !!data.adminInvisible;
        }
        if (data.animState !== undefined && data.animState !== null) {
            player.animState = normalizePlayerAnimState(data.animState);
        }

        const pilotSlot = player.pilotingAircraftId;
        if (pilotSlot && data.aircraftPose && String(data.aircraftPose.slotId || '') === String(pilotSlot)) {
            if (!roomState.aircraft) {
                roomState.aircraft = { pilots: new Map(), poses: new Map() };
            }
            const ap = data.aircraftPose;
            const pq = ap.position;
            const qq = ap.quaternion;
            if (pq && qq
                && [pq.x, pq.y, pq.z].every((n) => typeof n === 'number' && Number.isFinite(n))
                && [qq.x, qq.y, qq.z, qq.w].every((n) => typeof n === 'number' && Number.isFinite(n))) {
                roomState.aircraft.poses.set(pilotSlot, {
                    position: { x: pq.x, y: pq.y, z: pq.z },
                    quaternion: { x: qq.x, y: qq.y, z: qq.z, w: qq.w },
                    timestamp: incomingTimestamp
                });
            }
        }

        player.timestamp = incomingTimestamp;
        player.world = currentRoom;
    });

    socket.on('aircraft-board', (data, callback) => {
        const slotId = data && String(data.slotId || '').trim();
        const world = socket.data.currentRoom;
        if (!slotId || !world) {
            if (typeof callback === 'function') callback({ ok: false, error: 'bad_request' });
            return;
        }
        if (!worldContainsAircraftSlot(world, slotId)) {
            if (typeof callback === 'function') callback({ ok: false, error: 'invalid_slot' });
            return;
        }
        const rs = getRoomState(world);
        if (rs.aircraft.pilots.has(slotId)) {
            if (typeof callback === 'function') callback({ ok: false, error: 'busy' });
            return;
        }
        const pl = rs.players.get(socket.id);
        if (!pl) {
            if (typeof callback === 'function') callback({ ok: false, error: 'no_player' });
            return;
        }
        if (pl.pilotingAircraftId) {
            if (typeof callback === 'function') callback({ ok: false, error: 'already_piloting' });
            return;
        }
        rs.aircraft.pilots.set(slotId, socket.id);
        pl.pilotingAircraftId = slotId;
        if (typeof callback === 'function') callback({ ok: true });
    });

    socket.on('aircraft-exit', (data, callback) => {
        const world = socket.data.currentRoom;
        if (!world) {
            if (typeof callback === 'function') callback({ ok: false, error: 'no_room' });
            return;
        }
        const rs = getRoomState(world);
        const pl = rs.players.get(socket.id);
        const slotId = (data && String(data.slotId || '').trim()) || (pl && pl.pilotingAircraftId);
        if (!slotId || rs.aircraft.pilots.get(slotId) !== socket.id) {
            if (typeof callback === 'function') callback({ ok: false, error: 'not_pilot' });
            return;
        }
        rs.aircraft.pilots.delete(slotId);
        rs.aircraft.poses.delete(slotId);
        if (pl) pl.pilotingAircraftId = null;
        io.to(world).emit('aircraft-released', { slotId });
        if (typeof callback === 'function') callback({ ok: true });
    });

    // Handle world/room change (callback は Socket.io ack: テレポーター権限拒否時や完了時に使用)
    socket.on('change-world', async (data, callback) => {
        const oldRoom = socket.data.currentRoom;
        const newRoom = data.world || DEFAULT_ROOM;

        if (oldRoom === newRoom) return;

        if (!isValidWorldRoomId(newRoom)) {
            if (typeof callback === 'function') callback({ error: 'invalid_world', message: '存在しないワールドです。' });
            else socket.emit('change-world-rejected', { reason: 'invalid_world', message: '存在しないワールドです。' });
            return;
        }

        const teleporterId = data.teleporterId;
        if (teleporterId != null && teleporterId !== '') {
            const effectiveRole = socket.data.isAdmin ? 'admin' : (socket.data.role || 'guest');
            const worlds = readWorlds();
            const worldConfig = worlds[oldRoom];
            let teleporterAccess = 'public';
            if (worldConfig && Array.isArray(worldConfig.models)) {
                for (const m of worldConfig.models) {
                    if (m.teleporter && m.teleporter.id === teleporterId) {
                        teleporterAccess = m.teleporter.access || 'public';
                        break;
                    }
                }
            }
            if (!canUseTeleporter(teleporterAccess, effectiveRole)) {
                if (typeof callback === 'function') callback({ error: 'permission_denied', message: 'このテレポーターは利用権限がありません。' });
                else socket.emit('change-world-rejected', { reason: 'permission_denied', message: 'このテレポーターは利用権限がありません。' });
                return;
            }
        }

        const oldRoomState = oldRoom ? getRoomState(oldRoom) : null;
        const oldPlayerState = oldRoomState ? oldRoomState.players.get(socket.id) : null;
        const username = oldPlayerState ? oldPlayerState.username : 'Guest';

        // Remove from old room
        if (oldRoom) {
            releaseAllAircraftForPlayerInRoom(io, oldRoom, socket.id);
            oldRoomState.players.delete(socket.id);
            socket.leave(oldRoom);
            socket.to(oldRoom).emit('player-left', socket.id);
            console.log(`Player ${socket.id} left room: ${oldRoom}`);
        }

        // Add to new room
        socket.join(newRoom);
        socket.data.currentRoom = newRoom;

        const newRoomState = getRoomState(newRoom);
        const playerState = {
            id: socket.id,
            username: username,
            isAdmin: !!socket.data.isAdmin,
            position: { x: 0, y: 2, z: 0 },
            rotation: { x: 0, y: 0, z: 0 },
            quaternion: { x: 0, y: 0, z: 0, w: 1 },
            world: newRoom,
            timestamp: 0,
            adminInvisible: !!(oldPlayerState && oldPlayerState.adminInvisible),
            animState: normalizePlayerAnimState(oldPlayerState?.animState) || 'idle',
            serverLowAssistPrev: null,
            serverLowAssistAt: Date.now(),
            pilotingAircraftId: null
        };
        newRoomState.players.set(socket.id, playerState);
        setPhysicsAssistGrace(socket);

        const acInit = buildAircraftSnapshotList(newRoomState);
        if (acInit.length > 0) {
            socket.emit('aircraft-initial', { aircraft: acInit });
        }

        // Notify new room
        socket.to(newRoom).emit('player-joined', playerState);
        console.log(`Player ${socket.id} joined room: ${newRoom}`);

        // VC: Cleanup old VC room and update to new room
        await cleanupVCPeer(socket.id);
        socket.emit('vc-room-changed', { roomId: newRoom });

        // Video VC: Cleanup old room and notify client
        await cleanupVideoVCPeer(socket.id);
        socket.emit('video-vc-room-changed', { roomId: newRoom });

        if (typeof callback === 'function') callback();
    });

    // Handle disconnection
    // Handle chat message
    socket.on('chat-message', (message) => {
        const currentRoom = socket.data.currentRoom;
        if (!currentRoom) return;

        const roomState = getRoomState(currentRoom);
        const player = roomState.players.get(socket.id);
        
        if (!player || !message || message.trim().length === 0) return;

        const chatData = {
            senderId: socket.id,
            senderName: player.username,
            message: message.trim(),
            timestamp: Date.now()
        };

        console.log(`[CHAT] ${player.username}: ${message.trim()}`);

        // Save chat log
        addChatLog(currentRoom, player.username, message.trim());

        // Broadcast to others in room
        socket.to(currentRoom).emit('chat-receive', chatData);
        
        // Echo back to sender
        socket.emit('chat-my-message', chatData);
    });

    // Handle emoji/stamp
    socket.on('send-emoji', (data) => {
        const currentRoom = socket.data.currentRoom;
        if (!currentRoom) return;

        const roomState = getRoomState(currentRoom);
        const player = roomState.players.get(socket.id);
        
        if (!player || !data || !data.emoji) return;

        console.log(`[EMOJI] ${player.username}: ${data.emoji}`);

        // Broadcast to all in room (including sender)
        io.to(currentRoom).emit('emoji-broadcast', {
            playerId: socket.id,
            playerName: player.username,
            emoji: data.emoji
        });
    });

    // PDF viewer: join/leave room per PDF, broadcast draw
    socket.on('pdf-viewer-open', (pdfPath) => {
        if (pdfPath && typeof pdfPath === 'string') {
            const room = 'pdf:' + pdfPath;
            socket.join(room);
        }
    });
    socket.on('pdf-viewer-close', (pdfPath) => {
        if (pdfPath && typeof pdfPath === 'string') {
            const room = 'pdf:' + pdfPath;
            socket.leave(room);
        }
    });
    socket.on('pdf-draw', ({ pdfPath, points, id, lineWidth }) => {
        if (!pdfPath || !Array.isArray(points) || points.length < 2) return;
        const room = 'pdf:' + pdfPath;
        io.to(room).emit('pdf-draw', { points, id, drawnAt: Date.now(), lineWidth: lineWidth ?? 3 });
    });

    // ============================
    // VC Event Handlers
    // ============================
    
    // VC: Join room
    socket.on('vc-join', async ({ roomId }, callback) => {
        try {
            if (!roomId || typeof roomId !== 'string' || !isValidWorldRoomId(roomId)) {
                return callback({ error: 'invalid_room' });
            }
            const router = await getOrCreateVCRouter(roomId);
            
            // Initialize peer state
            if (!vcPeers.has(socket.id)) {
                vcPeers.set(socket.id, {
                    roomId,
                    sendTransport: null,
                    recvTransport: null,
                    producers: new Map(),
                    consumers: new Map(),
                });
            }
            
            console.log(`[VC] ${socket.id} joined VC room: ${roomId}`);
            
            callback({
                rtpCapabilities: router.rtpCapabilities,
                iceServers: await getIceServers(),
            });
        } catch (error) {
            console.error(`[VC] Error joining room:`, error);
            callback({ error: error.message });
        }
    });
    
    // VC: Create transport
    socket.on('vc-create-transport', async ({ direction }, callback) => {
        try {
            const peer = vcPeers.get(socket.id);
            if (!peer) {
                throw new Error('Peer not found');
            }
            
            const router = await getOrCreateVCRouter(peer.roomId);
            const transport = await router.createWebRtcTransport({
                ...mediasoupConfig.webRtcTransport,
                enableUdp: true,
                enableTcp: true,
                preferUdp: true,
            });
            
            if (direction === 'send') {
                peer.sendTransport = transport;
            } else {
                peer.recvTransport = transport;
            }
            
            // Monitor transport connection state
            transport.on('icestatechange', (iceState) => {
                console.log(`[VC] ${direction} transport ${transport.id} ICE state: ${iceState} (peer: ${socket.id})`);
            });
            
            transport.on('iceselectedtuplechange', (tuple) => {
                console.log(`[VC] ${direction} transport ${transport.id} ICE selected tuple: ${tuple.protocol} ${tuple.ip}:${tuple.port} (peer: ${socket.id})`);
            });
            
            transport.on('dtlsstatechange', (dtlsState) => {
                console.log(`[VC] ${direction} transport ${transport.id} DTLS state: ${dtlsState} (peer: ${socket.id})`);
                if (dtlsState === 'failed' || dtlsState === 'closed') {
                    console.error(`[VC] ❌ ${direction} transport DTLS FAILED for ${socket.id}`);
                }
            });
            
            transport.on('sctpstatechange', (sctpState) => {
                console.log(`[VC] ${direction} transport ${transport.id} SCTP state: ${sctpState} (peer: ${socket.id})`);
            });
            
            console.log(`[VC] Created ${direction} transport for ${socket.id}`, {
                transportId: transport.id,
                iceCandidates: transport.iceCandidates.map(c => `${c.protocol} ${c.ip}:${c.port} (${c.type})`),
            });
            
            callback({
                id: transport.id,
                iceParameters: transport.iceParameters,
                iceCandidates: transport.iceCandidates,
                dtlsParameters: transport.dtlsParameters,
            });
        } catch (error) {
            console.error(`[VC] Error creating transport:`, error);
            callback({ error: error.message });
        }
    });
    
    // VC: Connect transport
    socket.on('vc-connect-transport', async ({ transportId, dtlsParameters }, callback) => {
        try {
            const peer = vcPeers.get(socket.id);
            if (!peer) {
                throw new Error('Peer not found');
            }
            
            const transport = peer.sendTransport?.id === transportId ? peer.sendTransport : peer.recvTransport;
            if (!transport) {
                throw new Error('Transport not found');
            }
            
            await transport.connect({ dtlsParameters });
            console.log(`[VC] Transport ${transportId} connected for ${socket.id}`);
            
            callback({ success: true });
        } catch (error) {
            console.error(`[VC] Error connecting transport:`, error);
            callback({ error: error.message });
        }
    });
    
    // VC: Set mic (ON/OFF with max 10 enforcement)
    socket.on('vc-set-mic', async ({ enabled }, callback) => {
        try {
            const peer = vcPeers.get(socket.id);
            if (!peer) {
                throw new Error('Peer not found');
            }
            
            if (enabled) {
                // Check max active producers in room
                const router = await getOrCreateVCRouter(peer.roomId);
                const activeProducers = Array.from(vcPeers.values()).filter(
                    p => p.roomId === peer.roomId && p.producers.size > 0
                ).length;
                
                if (activeProducers >= MAX_ACTIVE_PRODUCERS_PER_ROOM) {
                    console.log(`[VC] Mic denied for ${socket.id}: max ${MAX_ACTIVE_PRODUCERS_PER_ROOM} active`);
                    callback({ 
                        denied: true, 
                        reason: `同時マイクONは最大${MAX_ACTIVE_PRODUCERS_PER_ROOM}人までです` 
                    });
                    return;
                }
                
                callback({ allowed: true });
            } else {
                // Mic OFF: close producer and sendTransport
                if (peer.sendTransport) {
                    // Close all producers
                    for (const [producerId, producer] of peer.producers) {
                        producer.close();
                        peer.producers.delete(producerId);
                        
                        // Notify other peers to remove this producer
                        socket.to(peer.roomId).emit('vc-producer-closed', { producerId });
                    }
                    
                    // Close sendTransport
                    peer.sendTransport.close();
                    peer.sendTransport = null;
                }
                
                console.log(`[VC] Mic OFF for ${socket.id}, sendTransport closed`);
                callback({ success: true });
            }
        } catch (error) {
            console.error(`[VC] Error setting mic:`, error);
            callback({ error: error.message });
        }
    });
    
    // VC: Produce audio
    socket.on('vc-produce-audio', async ({ transportId, rtpParameters, loopback }, callback) => {
        try {
            const peer = vcPeers.get(socket.id);
            if (!peer) {
                throw new Error('Peer not found');
            }
            
            if (!peer.sendTransport) {
                throw new Error('Send transport not found');
            }
            
            const producer = await peer.sendTransport.produce({
                kind: 'audio',
                rtpParameters,
            });
            
            peer.producers.set(producer.id, producer);
            
            producer.on('transportclose', () => {
                peer.producers.delete(producer.id);
            });
            
            console.log(`[VC] Audio producer created for ${socket.id}: ${producer.id}${loopback ? ' (loopback)' : ''}`);

            if (loopback) {
                // マイクテスト: 自分自身にだけループバック通知（他者には送らない）
                io.to(socket.id).emit('vc-new-producer', {
                    producerId: producer.id,
                    peerId: socket.id,
                });
                console.log(`[VC] → Sent vc-new-producer (loopback) to self`);
            } else {
                // 通常: 他ピアにのみ通知
                const notifiedPeers = [];
                for (const [peerId, peerData] of vcPeers) {
                    if (peerId !== socket.id && peerData.roomId === peer.roomId && peerData.recvTransport) {
                        io.to(peerId).emit('vc-new-producer', {
                            producerId: producer.id,
                            peerId: socket.id,
                        });
                        notifiedPeers.push(peerId);
                        console.log(`[VC] → Sent vc-new-producer to ${peerId}`);
                    }
                }
                console.log(`[VC] Notified ${notifiedPeers.length} peers about new producer`);
            }
            
            callback({ producerId: producer.id });
        } catch (error) {
            console.error(`[VC] Error producing audio:`, error);
            callback({ error: error.message });
        }
    });
    
    // VC: Set speaker (ON/OFF)
    socket.on('vc-set-speaker', async ({ enabled }, callback) => {
        try {
            const peer = vcPeers.get(socket.id);
            if (!peer) {
                throw new Error('Peer not found');
            }
            
            if (!enabled) {
                // Speaker OFF: close all consumers and recvTransport
                if (peer.recvTransport) {
                    for (const [consumerId, consumer] of peer.consumers) {
                        consumer.close();
                        peer.consumers.delete(consumerId);
                    }
                    
                    peer.recvTransport.close();
                    peer.recvTransport = null;
                }
                
                console.log(`[VC] Speaker OFF for ${socket.id}, recvTransport closed`);
                callback({ success: true });
            } else {
                // Speaker ON: Notify about existing producers in the room
                console.log(`[VC] Speaker ON for ${socket.id}, notifying about existing producers...`);
                
                // Find all existing producers in the same room
                const existingProducers = [];
                for (const [peerId, peerData] of vcPeers) {
                    if (peerId !== socket.id && peerData.roomId === peer.roomId && peerData.producers.size > 0) {
                        for (const [producerId, producer] of peerData.producers) {
                            existingProducers.push({ producerId, peerId });
                        }
                    }
                }
                
                console.log(`[VC] Found ${existingProducers.length} existing producers for ${socket.id}`);
                
                // Notify client about existing producers (client will consume after creating recvTransport)
                callback({ 
                    success: true, 
                    existingProducers: existingProducers 
                });
            }
        } catch (error) {
            console.error(`[VC] Error setting speaker:`, error);
            callback({ error: error.message });
        }
    });
    
    // VC: Consume (create consumer for a producer)
    socket.on('vc-consume', async ({ producerId, rtpCapabilities }, callback) => {
        try {
            console.log(`[VC] ${socket.id} requested to consume producer: ${producerId}`);
            
            const peer = vcPeers.get(socket.id);
            if (!peer || !peer.recvTransport) {
                console.error(`[VC] Peer or recv transport not found for ${socket.id}`);
                throw new Error('Peer or recv transport not found');
            }
            
            const router = await getOrCreateVCRouter(peer.roomId);
            
            if (!router.canConsume({ producerId, rtpCapabilities })) {
                console.error(`[VC] Cannot consume producer ${producerId} for ${socket.id}`);
                throw new Error('Cannot consume');
            }
            
            console.log(`[VC] Creating consumer for ${socket.id}...`);
            const consumer = await peer.recvTransport.consume({
                producerId,
                rtpCapabilities,
                paused: true,
            });
            
            peer.consumers.set(consumer.id, consumer);
            
            consumer.on('transportclose', () => {
                console.log(`[VC] Consumer ${consumer.id} transport closed`);
                peer.consumers.delete(consumer.id);
            });
            
            consumer.on('producerclose', () => {
                console.log(`[VC] Consumer ${consumer.id} producer closed`);
                peer.consumers.delete(consumer.id);
                socket.emit('vc-consumer-closed', { consumerId: consumer.id });
            });
            
            console.log(`[VC] ✅ Consumer created for ${socket.id}: ${consumer.id} (kind: ${consumer.kind})`);

            callback({
                consumerId: consumer.id,
                producerId,
                kind: consumer.kind,
                rtpParameters: consumer.rtpParameters,
            });
        } catch (error) {
            console.error(`[VC] ❌ Error consuming:`, error);
            callback({ error: error.message });
        }
    });
    
    // VC: Resume consumer
    socket.on('vc-consumer-resume', async ({ consumerId }, callback) => {
        try {
            console.log(`[VC] ${socket.id} requested to resume consumer: ${consumerId}`);
            
            const peer = vcPeers.get(socket.id);
            if (!peer) {
                console.error(`[VC] Peer not found for ${socket.id}`);
                throw new Error('Peer not found');
            }
            
            const consumer = peer.consumers.get(consumerId);
            if (!consumer) {
                console.error(`[VC] Consumer ${consumerId} not found for ${socket.id}`);
                throw new Error('Consumer not found');
            }
            
            await consumer.resume();
            console.log(`[VC] ✅ Consumer resumed: ${consumerId} for ${socket.id}`);
            
            callback({ success: true });
        } catch (error) {
            console.error(`[VC] ❌ Error resuming consumer:`, error);
            callback({ error: error.message });
        }
    });
    
    // VC: Leave (cleanup)
    socket.on('vc-leave', async (data, callback) => {
        try {
            await cleanupVCPeer(socket.id);
            if (callback) callback({ success: true });
        } catch (error) {
            console.error(`[VC] Error leaving:`, error);
            if (callback) callback({ error: error.message });
        }
    });

    // ============================
    // PDF VC Event Handlers
    // ============================
    socket.on('pdf-vc-join', async ({ pdfPath }, callback) => {
        try {
            if (!pdfPath || typeof pdfPath !== 'string') {
                callback({ error: 'pdfPath required' });
                return;
            }
            const absPdf = resolvePathUnderStorageRoot(PDFS_DIR, pdfPath);
            if (!absPdf || !absPdf.toLowerCase().endsWith('.pdf')) {
                callback({ error: 'invalid_pdf_path' });
                return;
            }
            let pdfStat;
            try {
                pdfStat = fs.statSync(absPdf);
            } catch (_) {
                callback({ error: 'invalid_pdf_path' });
                return;
            }
            if (!pdfStat.isFile()) {
                callback({ error: 'invalid_pdf_path' });
                return;
            }
            const pdfRoomId = 'pdf:' + pdfPath;
            const router = await getOrCreatePdfVCRouter(pdfRoomId);

            if (pdfVcPeers.has(socket.id)) {
                await cleanupPdfVCPeer(socket.id);
            }
            pdfVcPeers.set(socket.id, {
                pdfRoomId,
                sendTransport: null,
                recvTransport: null,
                producers: new Map(),
                consumers: new Map(),
            });

            console.log(`[PDF VC] ${socket.id} joined pdf VC room: ${pdfRoomId}`);
            callback({
                rtpCapabilities: router.rtpCapabilities,
                iceServers: await getIceServers(),
            });
        } catch (error) {
            console.error(`[PDF VC] Error joining:`, error);
            callback({ error: error.message });
        }
    });

    socket.on('pdf-vc-create-transport', async ({ direction }, callback) => {
        try {
            const peer = pdfVcPeers.get(socket.id);
            if (!peer) throw new Error('Peer not found');

            const router = await getOrCreatePdfVCRouter(peer.pdfRoomId);
            const transport = await router.createWebRtcTransport({
                ...pdfVcMediasoupConfig.webRtcTransport,
                enableUdp: true,
                enableTcp: true,
                preferUdp: true,
            });

            if (direction === 'send') peer.sendTransport = transport;
            else peer.recvTransport = transport;

            transport.on('icestatechange', (iceState) => {
                console.log(`[PDF VC] ${direction} transport ${transport.id} ICE state: ${iceState} (peer: ${socket.id})`);
            });
            transport.on('dtlsstatechange', (dtlsState) => {
                if (dtlsState === 'failed' || dtlsState === 'closed') {
                    console.error(`[PDF VC] ${direction} transport DTLS failed for ${socket.id}`);
                }
            });

            callback({
                id: transport.id,
                iceParameters: transport.iceParameters,
                iceCandidates: transport.iceCandidates,
                dtlsParameters: transport.dtlsParameters,
            });
        } catch (error) {
            console.error(`[PDF VC] Error creating transport:`, error);
            callback({ error: error.message });
        }
    });

    socket.on('pdf-vc-connect-transport', async ({ transportId, dtlsParameters }, callback) => {
        try {
            const peer = pdfVcPeers.get(socket.id);
            if (!peer) throw new Error('Peer not found');
            const transport = peer.sendTransport?.id === transportId ? peer.sendTransport : peer.recvTransport;
            if (!transport) throw new Error('Transport not found');
            await transport.connect({ dtlsParameters });
            console.log(`[PDF VC] Transport ${transportId} connected for ${socket.id}`);
            callback({ success: true });
        } catch (error) {
            console.error(`[PDF VC] Error connecting transport:`, error);
            callback({ error: error.message });
        }
    });

    socket.on('pdf-vc-set-mic', async ({ enabled }, callback) => {
        try {
            const peer = pdfVcPeers.get(socket.id);
            if (!peer) throw new Error('Peer not found');

            if (enabled) {
                const activeProducers = Array.from(pdfVcPeers.values()).filter(
                    p => p.pdfRoomId === peer.pdfRoomId && p.producers.size > 0
                ).length;
                if (activeProducers >= MAX_ACTIVE_PRODUCERS_PER_ROOM) {
                    callback({ denied: true, reason: `同時マイクONは最大${MAX_ACTIVE_PRODUCERS_PER_ROOM}人までです` });
                    return;
                }
                callback({ allowed: true });
            } else {
                if (peer.sendTransport) {
                    for (const [producerId, producer] of peer.producers) {
                        producer.close();
                        peer.producers.delete(producerId);
                        io.to(peer.pdfRoomId).emit('pdf-vc-producer-closed', { producerId });
                    }
                    peer.sendTransport.close();
                    peer.sendTransport = null;
                }
                callback({ success: true });
            }
        } catch (error) {
            console.error(`[PDF VC] Error setting mic:`, error);
            callback({ error: error.message });
        }
    });

    socket.on('pdf-vc-produce-audio', async ({ transportId, rtpParameters }, callback) => {
        try {
            const peer = pdfVcPeers.get(socket.id);
            if (!peer) throw new Error('Peer not found');
            if (!peer.sendTransport) throw new Error('Send transport not found');

            const producer = await peer.sendTransport.produce({ kind: 'audio', rtpParameters });
            peer.producers.set(producer.id, producer);
            producer.on('transportclose', () => peer.producers.delete(producer.id));

            for (const [peerId, peerData] of pdfVcPeers) {
                if (peerId !== socket.id && peerData.pdfRoomId === peer.pdfRoomId && peerData.recvTransport) {
                    io.to(peerId).emit('pdf-vc-new-producer', { producerId: producer.id, peerId: socket.id });
                }
            }
            callback({ producerId: producer.id });
        } catch (error) {
            console.error(`[PDF VC] Error producing audio:`, error);
            callback({ error: error.message });
        }
    });

    socket.on('pdf-vc-set-speaker', async ({ enabled }, callback) => {
        try {
            const peer = pdfVcPeers.get(socket.id);
            if (!peer) throw new Error('Peer not found');

            if (!enabled) {
                if (peer.recvTransport) {
                    for (const [consumerId, consumer] of peer.consumers) {
                        consumer.close();
                        peer.consumers.delete(consumerId);
                    }
                    peer.recvTransport.close();
                    peer.recvTransport = null;
                }
                callback({ success: true });
            } else {
                const existingProducers = [];
                for (const [peerId, peerData] of pdfVcPeers) {
                    if (peerId !== socket.id && peerData.pdfRoomId === peer.pdfRoomId && peerData.producers.size > 0) {
                        for (const [producerId] of peerData.producers) {
                            existingProducers.push({ producerId, peerId });
                        }
                    }
                }
                callback({ success: true, existingProducers });
            }
        } catch (error) {
            console.error(`[PDF VC] Error setting speaker:`, error);
            callback({ error: error.message });
        }
    });

    socket.on('pdf-vc-consume', async ({ producerId, rtpCapabilities }, callback) => {
        try {
            const peer = pdfVcPeers.get(socket.id);
            if (!peer || !peer.recvTransport) throw new Error('Peer or recv transport not found');

            const router = await getOrCreatePdfVCRouter(peer.pdfRoomId);
            if (!router.canConsume({ producerId, rtpCapabilities })) throw new Error('Cannot consume');

            const consumer = await peer.recvTransport.consume({
                producerId,
                rtpCapabilities,
                paused: true,
            });
            peer.consumers.set(consumer.id, consumer);
            consumer.on('transportclose', () => peer.consumers.delete(consumer.id));
            consumer.on('producerclose', () => {
                peer.consumers.delete(consumer.id);
                socket.emit('pdf-vc-consumer-closed', { consumerId: consumer.id });
            });

            callback({
                consumerId: consumer.id,
                producerId,
                kind: consumer.kind,
                rtpParameters: consumer.rtpParameters,
            });
        } catch (error) {
            console.error(`[PDF VC] Error consuming:`, error);
            callback({ error: error.message });
        }
    });

    socket.on('pdf-vc-consumer-resume', async ({ consumerId }, callback) => {
        try {
            const peer = pdfVcPeers.get(socket.id);
            if (!peer) throw new Error('Peer not found');
            const consumer = peer.consumers.get(consumerId);
            if (!consumer) throw new Error('Consumer not found');
            await consumer.resume();
            callback({ success: true });
        } catch (error) {
            console.error(`[PDF VC] Error resuming consumer:`, error);
            callback({ error: error.message });
        }
    });

    socket.on('pdf-vc-leave', async (data, callback) => {
        try {
            await cleanupPdfVCPeer(socket.id);
            if (callback) callback({ success: true });
        } catch (error) {
            console.error(`[PDF VC] Error leaving:`, error);
            if (callback) callback({ error: error.message });
        }
    });

    // ============================
    // Video VC Event Handlers
    // ============================
    socket.on('video-vc-join', async ({ roomId }, callback) => {
        try {
            const room = roomId || socket.data.currentRoom || DEFAULT_ROOM;
            if (!isValidWorldRoomId(room)) {
                return callback({ error: 'invalid_room' });
            }
            const router = await getOrCreateVideoVCRouter(room);

            if (videoVcPeers.has(socket.id)) {
                await cleanupVideoVCPeer(socket.id);
            }
            videoVcPeers.set(socket.id, {
                roomId: room,
                sendTransport: null,
                recvTransport: null,
                producers: new Map(),
                consumers: new Map(),
            });

            console.log(`[Video VC] ${socket.id} joined room: ${room}`);
            callback({
                rtpCapabilities: router.rtpCapabilities,
                iceServers: await getIceServers(),
            });
        } catch (error) {
            console.error(`[Video VC] Error joining:`, error);
            callback({ error: error.message });
        }
    });

    socket.on('video-vc-create-transport', async ({ direction }, callback) => {
        try {
            const peer = videoVcPeers.get(socket.id);
            if (!peer) throw new Error('Peer not found');

            const router = await getOrCreateVideoVCRouter(peer.roomId);
            const transport = await router.createWebRtcTransport({
                ...videoVcMediasoupConfig.webRtcTransport,
                enableUdp: true,
                enableTcp: true,
                preferUdp: true,
            });

            if (direction === 'send') peer.sendTransport = transport;
            else peer.recvTransport = transport;

            transport.on('icestatechange', (iceState) => {
                console.log(`[Video VC] ${direction} transport ${transport.id} ICE state: ${iceState} (peer: ${socket.id})`);
            });
            transport.on('dtlsstatechange', (dtlsState) => {
                if (dtlsState === 'failed' || dtlsState === 'closed') {
                    console.error(`[Video VC] ${direction} transport DTLS failed for ${socket.id}`);
                }
            });

            callback({
                id: transport.id,
                iceParameters: transport.iceParameters,
                iceCandidates: transport.iceCandidates,
                dtlsParameters: transport.dtlsParameters,
            });
        } catch (error) {
            console.error(`[Video VC] Error creating transport:`, error);
            callback({ error: error.message });
        }
    });

    socket.on('video-vc-connect-transport', async ({ transportId, dtlsParameters }, callback) => {
        try {
            const peer = videoVcPeers.get(socket.id);
            if (!peer) throw new Error('Peer not found');
            const transport = peer.sendTransport?.id === transportId ? peer.sendTransport : peer.recvTransport;
            if (!transport) throw new Error('Transport not found');
            await transport.connect({ dtlsParameters });
            console.log(`[Video VC] Transport ${transportId} connected for ${socket.id}`);
            callback({ success: true });
        } catch (error) {
            console.error(`[Video VC] Error connecting transport:`, error);
            callback({ error: error.message });
        }
    });

    socket.on('video-vc-set-video', async ({ enabled }, callback) => {
        try {
            const peer = videoVcPeers.get(socket.id);
            if (!peer) throw new Error('Peer not found');

            if (enabled) {
                const activeProducers = Array.from(videoVcPeers.values()).filter(
                    p => p.roomId === peer.roomId && p.producers.size > 0
                ).length;
                if (activeProducers >= VIDEO_VC_MAX_PRODUCERS_PER_ROOM) {
                    callback({ denied: true, reason: `同時ビデオONは最大${VIDEO_VC_MAX_PRODUCERS_PER_ROOM}人までです` });
                    return;
                }
                callback({ allowed: true });
            } else {
                if (peer.sendTransport) {
                    for (const [producerId, producer] of peer.producers) {
                        producer.close();
                        peer.producers.delete(producerId);
                        io.to(peer.roomId).emit('video-vc-producer-closed', { producerId });
                    }
                    peer.sendTransport.close();
                    peer.sendTransport = null;
                }
                callback({ success: true });
            }
        } catch (error) {
            console.error(`[Video VC] Error setting video:`, error);
            callback({ error: error.message });
        }
    });

    socket.on('video-vc-produce-video', async ({ transportId, rtpParameters }, callback) => {
        try {
            const peer = videoVcPeers.get(socket.id);
            if (!peer) throw new Error('Peer not found');
            if (!peer.sendTransport) throw new Error('Send transport not found');

            const producer = await peer.sendTransport.produce({ kind: 'video', rtpParameters });
            peer.producers.set(producer.id, producer);
            producer.on('transportclose', () => peer.producers.delete(producer.id));

            for (const [peerId, peerData] of videoVcPeers) {
                if (peerId !== socket.id && peerData.roomId === peer.roomId && peerData.recvTransport) {
                    io.to(peerId).emit('video-vc-new-producer', { producerId: producer.id, peerId: socket.id, kind: 'video' });
                }
            }
            callback({ producerId: producer.id });
        } catch (error) {
            console.error(`[Video VC] Error producing video:`, error);
            callback({ error: error.message });
        }
    });

    socket.on('video-vc-produce-audio', async ({ transportId, rtpParameters }, callback) => {
        try {
            const peer = videoVcPeers.get(socket.id);
            if (!peer) throw new Error('Peer not found');
            if (!peer.sendTransport) throw new Error('Send transport not found');

            const producer = await peer.sendTransport.produce({ kind: 'audio', rtpParameters });
            peer.producers.set(producer.id, producer);
            producer.on('transportclose', () => peer.producers.delete(producer.id));

            for (const [peerId, peerData] of videoVcPeers) {
                if (peerId !== socket.id && peerData.roomId === peer.roomId && peerData.recvTransport) {
                    io.to(peerId).emit('video-vc-new-producer', { producerId: producer.id, peerId: socket.id, kind: 'audio' });
                }
            }
            callback({ producerId: producer.id });
        } catch (error) {
            console.error(`[Video VC] Error producing audio:`, error);
            callback({ error: error.message });
        }
    });

    socket.on('video-vc-set-recv', async ({ enabled }, callback) => {
        try {
            const peer = videoVcPeers.get(socket.id);
            if (!peer) throw new Error('Peer not found');

            if (!enabled) {
                if (peer.recvTransport) {
                    for (const [consumerId, consumer] of peer.consumers) {
                        consumer.close();
                        peer.consumers.delete(consumerId);
                    }
                    peer.recvTransport.close();
                    peer.recvTransport = null;
                }
                callback({ success: true });
            } else {
                const existingProducers = [];
                for (const [peerId, peerData] of videoVcPeers) {
                    if (peerId !== socket.id && peerData.roomId === peer.roomId && peerData.producers.size > 0) {
                        for (const [producerId, producer] of peerData.producers) {
                            existingProducers.push({ producerId, peerId, kind: producer.kind });
                        }
                    }
                }
                callback({ success: true, existingProducers });
            }
        } catch (error) {
            console.error(`[Video VC] Error setting recv:`, error);
            callback({ error: error.message });
        }
    });

    socket.on('video-vc-consume', async ({ producerId, rtpCapabilities }, callback) => {
        try {
            const peer = videoVcPeers.get(socket.id);
            if (!peer || !peer.recvTransport) throw new Error('Peer or recv transport not found');

            const router = await getOrCreateVideoVCRouter(peer.roomId);
            if (!router.canConsume({ producerId, rtpCapabilities })) throw new Error('Cannot consume');

            const consumer = await peer.recvTransport.consume({
                producerId,
                rtpCapabilities,
                paused: true,
            });
            peer.consumers.set(consumer.id, consumer);
            consumer.on('transportclose', () => peer.consumers.delete(consumer.id));
            consumer.on('producerclose', () => {
                peer.consumers.delete(consumer.id);
                socket.emit('video-vc-consumer-closed', { consumerId: consumer.id });
            });

            callback({
                consumerId: consumer.id,
                producerId,
                kind: consumer.kind,
                rtpParameters: consumer.rtpParameters,
            });
        } catch (error) {
            console.error(`[Video VC] Error consuming:`, error);
            callback({ error: error.message });
        }
    });

    socket.on('video-vc-consumer-resume', async ({ consumerId }, callback) => {
        try {
            const peer = videoVcPeers.get(socket.id);
            if (!peer) throw new Error('Peer not found');
            const consumer = peer.consumers.get(consumerId);
            if (!consumer) throw new Error('Consumer not found');
            await consumer.resume();
            callback({ success: true });
        } catch (error) {
            console.error(`[Video VC] Error resuming consumer:`, error);
            callback({ error: error.message });
        }
    });


    socket.on('video-vc-leave', async (data, callback) => {
        try {
            await cleanupVideoVCPeer(socket.id);
            if (callback) callback({ success: true });
        } catch (error) {
            console.error(`[Video VC] Error leaving:`, error);
            if (callback) callback({ error: error.message });
        }
    });

    socket.on('disconnect', async () => {
        console.log(`Player disconnected: ${socket.id}`);
        
        const currentRoom = socket.data.currentRoom;
        if (currentRoom) {
            releaseAllAircraftForPlayerInRoom(io, currentRoom, socket.id);
            const roomState = getRoomState(currentRoom);
            roomState.players.delete(socket.id);
            
            // Notify room members
            socket.to(currentRoom).emit('player-left', socket.id);
            
            console.log(`Player ${socket.id} removed from room: ${currentRoom}`);
        }
        
        // Cleanup VC peer, PDF VC peer, and Video VC peer
        await cleanupVCPeer(socket.id);
        await cleanupPdfVCPeer(socket.id);
        await cleanupVideoVCPeer(socket.id);

        // Cleanup traffic stats, ping, client info
        trafficStats.delete(socket.id);
        playerPings.delete(socket.id);
        clientInfo.delete(socket.id);
        if (CHART_FEATURES_ENABLED) {
            cleanupTaikoMpOnDisconnect(io, socket.id);
        }
    });
    
    // ============================
    // Admin: Socket.io Events
    // ============================

    // Admin get player info (for click on avatar in metaverse)
    socket.on('admin-get-player-info', (data, callback) => {
        if (!socket.data.isAdmin || !callback || typeof callback !== 'function') return;
        const { targetSocketId } = data || {};
        if (!targetSocketId) return callback({ error: 'targetSocketId required' });

        const currentRoom = socket.data.currentRoom;
        const roomState = currentRoom ? getRoomState(currentRoom) : null;
        const player = roomState?.players?.get(targetSocketId);
        if (!player || player.world !== currentRoom) return callback({ error: 'Player not found' });

        const stats = trafficStats.get(targetSocketId);
        const pingData = playerPings.get(targetSocketId);
        const info = clientInfo.get(targetSocketId);
        const now = Date.now();
        const pingFresh = pingData && (now - pingData.reportedAt) < PING_STALE_MS;
        const pingMs = pingFresh ? pingData.pingMs : null;
        const fpsSample = pingFresh && pingData.fpsSample != null ? pingData.fpsSample : null;
        const perfTier = pingFresh && pingData.effectiveTier ? pingData.effectiveTier : null;
        const loafCount = pingFresh ? (pingData.loafCount ?? null) : null;
        const longtaskCount = pingFresh ? (pingData.longtaskCount ?? null) : null;

        callback({
            username: player.username,
            displayName: player.isAdmin ? 'admin' : player.username,
            connectedAt: stats?.connectedAt || null,
            pingMs,
            fpsSample,
            perfTier,
            loafCount,
            longtaskCount,
            ip: info?.ip || '-',
            browser: info?.browser || '-',
            os: info?.os || '-'
        });
    });
    
    // Admin kick player
    socket.on('admin-kick-player', ({ targetSocketId }) => {
        if (!socket.data.isAdmin) return;
        const targetSocket = io.sockets.sockets.get(targetSocketId);
        if (targetSocket) {
            // Send kick notification before disconnecting
            targetSocket.emit('admin-kicked', { message: '管理者によってキックされました。' });
            // Small delay to ensure message is sent before disconnect
            setTimeout(() => {
                targetSocket.disconnect(true);
            }, 100);
            console.log(`[ADMIN] Player ${targetSocketId} kicked by admin`);
        }
    });
    
    // Admin mute mic
    socket.on('admin-mute-mic', async ({ targetSocketId }) => {
        if (!socket.data.isAdmin) return;
        const peer = vcPeers.get(targetSocketId);
        if (peer && peer.sendTransport) {
            // Close all producers
            for (const [producerId, producer] of peer.producers) {
                producer.close();
                peer.producers.delete(producerId);
                io.to(peer.roomId).emit('vc-producer-closed', { producerId });
            }
            // Close sendTransport
            peer.sendTransport.close();
            peer.sendTransport = null;
            console.log(`[ADMIN] Mic muted for player ${targetSocketId}`);
        }
    });
    
    // Admin send alert
    socket.on('admin-send-alert', ({ targetSocketId, message }) => {
        if (!socket.data.isAdmin) return;
        const targetSocket = io.sockets.sockets.get(targetSocketId);
        if (targetSocket && message) {
            targetSocket.emit('admin-alert', { message });
            console.log(`[ADMIN] Alert sent to player ${targetSocketId}: ${message}`);
        }
    });
});

// Server tick - broadcast player snapshots at 30fps (33ms interval) per room
setInterval(() => {
    const tickTimestamp = Date.now();
    
    // Iterate through all rooms
    roomStates.forEach((roomState, roomId) => {
        // Skip empty rooms
        if (roomState.players.size === 0) return;
        
        // Create snapshot for this room (include vcMicOn, vcSpeakerOn, pingMs for player list)
        const now = Date.now();
        const playersArray = Array.from(roomState.players.values()).map(player => {
            const vcPeer = vcPeers.get(player.id);
            const videoVcPeer = videoVcPeers.get(player.id);
            const vcMicOn = !!(vcPeer && vcPeer.sendTransport);
            const vcSpeakerOn = !!(vcPeer && vcPeer.recvTransport);
            const vcVideoOn = !!(videoVcPeer && videoVcPeer.sendTransport);
            const pingData = playerPings.get(player.id);
            const pingFresh = pingData && (now - pingData.reportedAt) < PING_STALE_MS;
            const pingMs = pingFresh ? pingData.pingMs : null;
            const fpsSample = pingFresh && pingData.fpsSample != null ? pingData.fpsSample : null;
            const perfTier = pingFresh && pingData.effectiveTier ? pingData.effectiveTier : null;
            const socket = io.sockets.sockets.get(player.id);
            const role = socket?.data?.role || null;
            return {
                id: player.id,
                username: player.username,
                displayName: getPlayerDisplayName(player),
                position: player.position,
                rotation: player.rotation,
                quaternion: player.quaternion,
                world: player.world,
                adminInvisible: !!player.adminInvisible,
                pilotingAircraftId: player.pilotingAircraftId || null,
                animState: normalizePlayerAnimState(player.animState),
                vcMicOn,
                vcSpeakerOn,
                vcVideoOn,
                pingMs,
                fpsSample,
                perfTier,
                role
            };
        });
        
        if (!roomState.aircraft) {
            roomState.aircraft = { pilots: new Map(), poses: new Map() };
        }
        const aircraftList = buildAircraftSnapshotList(roomState);

        const snapshot = {
            timestamp: tickTimestamp,
            players: playersArray,
            aircraft: aircraftList
        };
        
        // Broadcast to all players in this room
        io.to(roomId).emit('players-update', snapshot);
    });
}, 33);

// ============================
// Admin: API Endpoints
// ============================
app.get('/admin/enter-metaverse', (req, res) => {
    const token = generateAdminToken();
    res.json({ token, username: 'admin' });
});

app.get('/admin/worlds', (req, res) => {
    try {
        const worlds = readWorlds();
        res.json(worlds);
    } catch (err) {
        console.error('GET /admin/worlds error:', err);
        res.status(500).json({ error: 'Failed to read worlds' });
    }
});

app.post('/admin/worlds', (req, res) => {
    const worlds = req.body;
    if (!worlds || typeof worlds !== 'object') {
        return res.status(400).json({ error: 'Invalid body: expected worlds object' });
    }
        if (CHART_FEATURES_ENABLED) {
            const taikoErrs = validateWorldsTaikoMultiplayer(worlds);
            if (taikoErrs.length > 0) {
                return res.status(400).json({ error: taikoErrs.join(' ') });
            }
        }
        const aircraftErrs = validateWorldsAircraft(worlds);
        if (aircraftErrs.length > 0) {
            return res.status(400).json({ error: aircraftErrs.join(' ') });
        }
        const physicsErrs = validateWorldsPhysicsAssist(worlds);
        if (physicsErrs.length > 0) {
            return res.status(400).json({ error: physicsErrs.join(' ') });
        }
        const aircraftPhysErrs = validateWorldsAircraftPhysics(worlds);
        if (aircraftPhysErrs.length > 0) {
            return res.status(400).json({ error: aircraftPhysErrs.join(' ') });
        }
    const boundsErrs = validateWorldsPlayBoundsAndColliders(worlds);
    if (boundsErrs.length > 0) {
        return res.status(400).json({ error: boundsErrs.join(' ') });
    }
    const floorDimErrs = validateWorldsFloorDimensions(worlds);
    if (floorDimErrs.length > 0) {
        return res.status(400).json({ error: floorDimErrs.join(' ') });
    }
    normalizeWorldsLod(worlds);
    try {
        writeWorlds(worlds);
        res.json({ success: true });
    } catch (err) {
        console.error('POST /admin/worlds error:', err);
        res.status(500).json({ error: 'Failed to save worlds' });
    }
});

app.use('/admin/charts', (req, res, next) => {
    if (CHART_FEATURES_ENABLED) return next();
    res.status(503).json({
        error: '譜面機能はこのサーバーでは無効です',
        chartFeaturesEnabled: false
    });
});

app.get('/admin/charts', (req, res) => {
    try {
        const charts = readCharts();
        res.json(charts);
    } catch (err) {
        console.error('GET /admin/charts error:', err);
        res.status(500).json({ error: 'Failed to read charts' });
    }
});

app.post('/admin/charts', (req, res) => {
    const { id, name, notes } = req.body || {};
    if (!id || typeof id !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(id)) {
        return res.status(400).json({ error: 'Invalid or missing id (alphanumeric, underscore, hyphen)' });
    }
    const charts = readCharts();
    if (charts[id]) {
        return res.status(400).json({ error: 'Chart id already exists' });
    }
    const notesArr = Array.isArray(notes) ? notes : [];
    const difficulty = req.body.difficulty != null ? req.body.difficulty : null;
    const tempo = req.body.tempo != null ? Number(req.body.tempo) : null;
    const endTime = req.body.endTime != null && req.body.endTime !== '' ? Number(req.body.endTime) : null;
    const measureBpms = req.body.measureBpms != null ? req.body.measureBpms : null;
    const partNames = req.body.partNames != null && typeof req.body.partNames === 'object' ? req.body.partNames : null;
    const notes2Arr = Array.isArray(req.body.notes2) ? req.body.notes2 : [];
    const notes3Arr = Array.isArray(req.body.notes3) ? req.body.notes3 : [];
    charts[id] = { id, name: name || id, notes: notesArr, notes2: notes2Arr, notes3: notes3Arr, partNames, difficulty, tempo, endTime, measureBpms };
    try {
        writeCharts(charts);
        res.json({ success: true, chart: charts[id] });
    } catch (err) {
        console.error('POST /admin/charts error:', err);
        res.status(500).json({ error: 'Failed to save charts' });
    }
});

app.put('/admin/charts/:id', (req, res) => {
    const id = req.params.id;
    const charts = readCharts();
    if (!charts[id]) {
        return res.status(404).json({ error: 'Chart not found' });
    }
    const { name, notes, notes2, notes3, partNames, difficulty, tempo, endTime, measureBpms } = req.body || {};
    if (name !== undefined) charts[id].name = name;
    if (Array.isArray(notes)) charts[id].notes = notes;
    if (Array.isArray(notes2)) charts[id].notes2 = notes2;
    if (Array.isArray(notes3)) charts[id].notes3 = notes3;
    if (partNames !== undefined) charts[id].partNames = partNames;
    if (difficulty !== undefined) charts[id].difficulty = difficulty;
    if (tempo !== undefined) charts[id].tempo = tempo == null ? null : Number(tempo);
    if (endTime !== undefined) charts[id].endTime = endTime == null || endTime === '' ? null : Number(endTime);
    if (measureBpms !== undefined) charts[id].measureBpms = measureBpms == null ? null : measureBpms;
    try {
        writeCharts(charts);
        res.json({ success: true, chart: charts[id] });
    } catch (err) {
        console.error('PUT /admin/charts error:', err);
        res.status(500).json({ error: 'Failed to save charts' });
    }
});

/**
 * 譜面ヒット音（パート×音量帯×don|ka）用: partHitSounds の配列を 5 要素に揃える
 * @param {Record<string, unknown>} chart
 */
function ensurePartHitSoundsShape(chart) {
    if (!chart.partHitSounds || typeof chart.partHitSounds !== 'object') {
        chart.partHitSounds = {};
    }
    const ph = /** @type {Record<string, unknown>} */ (chart.partHitSounds);
    for (let p = 1; p <= 3; p++) {
        const k = String(p);
        if (!Array.isArray(ph[k])) {
            ph[k] = [];
        }
        const arr = /** @type {unknown[]} */ (ph[k]);
        while (arr.length < 5) {
            arr.push({});
        }
    }
}

app.delete('/admin/charts/:id', (req, res) => {
    const id = req.params.id;
    const charts = readCharts();
    if (!charts[id]) {
        return res.status(404).json({ error: 'Chart not found' });
    }
    delete charts[id];
    const bgmPath = path.join(CHART_BGM_DIR, `${id}.mp3`);
    const bgmWav = wavPathForMp3(bgmPath);
    try {
        if (fs.existsSync(bgmPath)) fs.unlinkSync(bgmPath);
        if (fs.existsSync(bgmWav)) fs.unlinkSync(bgmWav);
    } catch (e) {
        console.warn('DELETE chart BGM file:', e?.message || e);
    }
    for (const p of [1, 2, 3]) {
        const partPath = path.join(CHART_BGM_DIR, `${id}-p${p}.mp3`);
        const partWav = wavPathForMp3(partPath);
        try {
            if (fs.existsSync(partPath)) fs.unlinkSync(partPath);
            if (fs.existsSync(partWav)) fs.unlinkSync(partWav);
        } catch (e) {
            console.warn('DELETE chart part BGM file:', e?.message || e);
        }
    }
    const hitDir = path.join(CHART_BGM_DIR, id);
    try {
        if (fs.existsSync(hitDir)) {
            const st = fs.statSync(hitDir);
            if (st.isDirectory()) {
                fs.rmSync(hitDir, { recursive: true, force: true });
            }
        }
    } catch (e) {
        console.warn('DELETE chart hit sounds dir:', e?.message || e);
    }
    try {
        writeCharts(charts);
        res.json({ success: true });
    } catch (err) {
        console.error('DELETE /admin/charts error:', err);
        res.status(500).json({ error: 'Failed to save charts' });
    }
});

app.post('/admin/charts/:id/bgm', uploadChartBgm.single('bgm'), async (req, res) => {
    const id = req.params.id;
    if (!id || !/^[a-zA-Z0-9_-]+$/.test(id)) {
        return res.status(400).json({ error: 'Invalid chart id' });
    }
    if (!req.file || !req.file.buffer) {
        return res.status(400).json({ error: 'MP3ファイルを選択してください（フィールド名: bgm）' });
    }
    const charts = readCharts();
    if (!charts[id]) {
        return res.status(404).json({ error: 'Chart not found' });
    }
    try {
        const mp3Path = path.join(CHART_BGM_DIR, `${id}.mp3`);
        fs.writeFileSync(mp3Path, req.file.buffer);
        const okWav = await ensureWavSidecarForMp3Path(mp3Path);
        if (!okWav) console.warn('[chart-bgm] WAV sidecar failed for chart', id);
        const orig = path.basename(req.file.originalname || 'bgm.mp3');
        charts[id].bgmVersion = Date.now();
        charts[id].bgmOriginalName = orig.length > 200 ? orig.slice(0, 200) : orig;
        writeCharts(charts);
        res.json({ success: true, chart: charts[id] });
    } catch (err) {
        console.error('POST /admin/charts/:id/bgm error:', err);
        res.status(500).json({ error: 'BGMの保存に失敗しました' });
    }
});

app.delete('/admin/charts/:id/bgm', (req, res) => {
    const id = req.params.id;
    if (!id || !/^[a-zA-Z0-9_-]+$/.test(id)) {
        return res.status(400).json({ error: 'Invalid chart id' });
    }
    const charts = readCharts();
    if (!charts[id]) {
        return res.status(404).json({ error: 'Chart not found' });
    }
    try {
        const bgmPath = path.join(CHART_BGM_DIR, `${id}.mp3`);
        const bgmWav = wavPathForMp3(bgmPath);
        if (fs.existsSync(bgmPath)) fs.unlinkSync(bgmPath);
        if (fs.existsSync(bgmWav)) fs.unlinkSync(bgmWav);
        delete charts[id].bgmVersion;
        delete charts[id].bgmOriginalName;
        writeCharts(charts);
        res.json({ success: true, chart: charts[id] });
    } catch (err) {
        console.error('DELETE /admin/charts/:id/bgm error:', err);
        res.status(500).json({ error: 'BGMの削除に失敗しました' });
    }
});

/** 1P〜3P 用プレビューBGM（譜面ID-p{1|2|3}.mp3） */
app.post('/admin/charts/:id/bgm/part/:partNum', uploadChartBgm.single('bgm'), async (req, res) => {
    const id = req.params.id;
    const partNum = Number(req.params.partNum);
    if (!id || !/^[a-zA-Z0-9_-]+$/.test(id)) {
        return res.status(400).json({ error: 'Invalid chart id' });
    }
    if (![1, 2, 3].includes(partNum)) {
        return res.status(400).json({ error: 'part は 1〜3 を指定してください' });
    }
    if (!req.file || !req.file.buffer) {
        return res.status(400).json({ error: 'MP3ファイルを選択してください（フィールド名: bgm）' });
    }
    const charts = readCharts();
    if (!charts[id]) {
        return res.status(404).json({ error: 'Chart not found' });
    }
    try {
        const mp3Path = path.join(CHART_BGM_DIR, `${id}-p${partNum}.mp3`);
        fs.writeFileSync(mp3Path, req.file.buffer);
        const okWav = await ensureWavSidecarForMp3Path(mp3Path);
        if (!okWav) console.warn('[chart-bgm] WAV sidecar failed for part BGM', id, partNum);
        const orig = path.basename(req.file.originalname || 'bgm.mp3');
        if (!charts[id].partBgm || typeof charts[id].partBgm !== 'object') {
            charts[id].partBgm = {};
        }
        const pb = /** @type {Record<string, unknown>} */ (charts[id].partBgm);
        pb[String(partNum)] = {
            version: Date.now(),
            originalName: orig.length > 200 ? orig.slice(0, 200) : orig
        };
        writeCharts(charts);
        res.json({ success: true, chart: charts[id] });
    } catch (err) {
        console.error('POST /admin/charts/:id/bgm/part/:partNum error:', err);
        res.status(500).json({ error: 'パートBGMの保存に失敗しました' });
    }
});

app.delete('/admin/charts/:id/bgm/part/:partNum', (req, res) => {
    const id = req.params.id;
    const partNum = Number(req.params.partNum);
    if (!id || !/^[a-zA-Z0-9_-]+$/.test(id)) {
        return res.status(400).json({ error: 'Invalid chart id' });
    }
    if (![1, 2, 3].includes(partNum)) {
        return res.status(400).json({ error: 'part は 1〜3 を指定してください' });
    }
    const charts = readCharts();
    if (!charts[id]) {
        return res.status(404).json({ error: 'Chart not found' });
    }
    try {
        const partPath = path.join(CHART_BGM_DIR, `${id}-p${partNum}.mp3`);
        const partWav = wavPathForMp3(partPath);
        if (fs.existsSync(partPath)) fs.unlinkSync(partPath);
        if (fs.existsSync(partWav)) fs.unlinkSync(partWav);
        if (charts[id].partBgm && typeof charts[id].partBgm === 'object') {
            const pb = /** @type {Record<string, unknown>} */ (charts[id].partBgm);
            delete pb[String(partNum)];
            if (Object.keys(pb).length === 0) {
                delete charts[id].partBgm;
            }
        }
        writeCharts(charts);
        res.json({ success: true, chart: charts[id] });
    } catch (err) {
        console.error('DELETE /admin/charts/:id/bgm/part/:partNum error:', err);
        res.status(500).json({ error: 'パートBGMの削除に失敗しました' });
    }
});

/** パート(1–3)×音量帯(0–4)×don|ka のヒット音MP3をアップロード */
app.post('/admin/charts/:id/part-hit-sound', uploadChartBgm.single('sound'), async (req, res) => {
    const id = req.params.id;
    if (!id || !/^[a-zA-Z0-9_-]+$/.test(id)) {
        return res.status(400).json({ error: 'Invalid chart id' });
    }
    if (!req.file || !req.file.buffer) {
        return res.status(400).json({ error: 'MP3を選択してください（フィールド名: sound）' });
    }
    const part = Number(req.body.part);
    const bucket = Number(req.body.bucket);
    const kind = String(req.body.kind || '').toLowerCase();
    if (![1, 2, 3].includes(part) || ![0, 1, 2, 3, 4].includes(bucket) || (kind !== 'don' && kind !== 'ka')) {
        return res.status(400).json({ error: 'part(1-3), bucket(0-4), kind(don|ka) が不正です' });
    }
    const charts = readCharts();
    if (!charts[id]) {
        return res.status(404).json({ error: 'Chart not found' });
    }
    try {
        const hitDir = path.join(CHART_BGM_DIR, id, 'hits');
        fs.mkdirSync(hitDir, { recursive: true });
        const fname = `p${part}-b${bucket}-${kind}.mp3`;
        const mp3Path = path.join(hitDir, fname);
        fs.writeFileSync(mp3Path, req.file.buffer);
        const okWav = await ensureWavSidecarForMp3Path(mp3Path);
        if (!okWav) console.warn('[chart-bgm] WAV sidecar failed for hit sound', id, part, bucket, kind);
        ensurePartHitSoundsShape(charts[id]);
        const ph = /** @type {Record<string, Array<Record<string, unknown>>>} */ (charts[id].partHitSounds);
        const arr = ph[String(part)];
        const cell = { ...(arr[bucket] || {}) };
        const ver = Date.now();
        const orig = path.basename(req.file.originalname || `${kind}.mp3`);
        const oname = orig.length > 200 ? orig.slice(0, 200) : orig;
        if (kind === 'don') {
            cell.donVersion = ver;
            cell.donOriginalName = oname;
        } else {
            cell.kaVersion = ver;
            cell.kaOriginalName = oname;
        }
        arr[bucket] = cell;
        writeCharts(charts);
        res.json({ success: true, chart: charts[id] });
    } catch (err) {
        console.error('POST /admin/charts/:id/part-hit-sound error:', err);
        res.status(500).json({ error: 'ヒット音の保存に失敗しました' });
    }
});

app.delete('/admin/charts/:id/part-hit-sound', (req, res) => {
    const id = req.params.id;
    if (!id || !/^[a-zA-Z0-9_-]+$/.test(id)) {
        return res.status(400).json({ error: 'Invalid chart id' });
    }
    const part = Number(req.query.part);
    const bucket = Number(req.query.bucket);
    const kind = String(req.query.kind || '').toLowerCase();
    if (![1, 2, 3].includes(part) || ![0, 1, 2, 3, 4].includes(bucket) || (kind !== 'don' && kind !== 'ka')) {
        return res.status(400).json({ error: 'part(1-3), bucket(0-4), kind(don|ka) が不正です' });
    }
    const charts = readCharts();
    if (!charts[id]) {
        return res.status(404).json({ error: 'Chart not found' });
    }
    const fpath = path.join(CHART_BGM_DIR, id, 'hits', `p${part}-b${bucket}-${kind}.mp3`);
    const fwav = wavPathForMp3(fpath);
    try {
        if (fs.existsSync(fpath)) fs.unlinkSync(fpath);
        if (fs.existsSync(fwav)) fs.unlinkSync(fwav);
    } catch (e) {
        console.warn('DELETE part-hit-sound file:', e?.message || e);
    }
    try {
        ensurePartHitSoundsShape(charts[id]);
        const ph = /** @type {Record<string, Array<Record<string, unknown>>>} */ (charts[id].partHitSounds);
        const arr = ph[String(part)];
        const cell = { ...(arr[bucket] || {}) };
        if (kind === 'don') {
            delete cell.donVersion;
            delete cell.donOriginalName;
        } else {
            delete cell.kaVersion;
            delete cell.kaOriginalName;
        }
        arr[bucket] = cell;
        writeCharts(charts);
        res.json({ success: true, chart: charts[id] });
    } catch (err) {
        console.error('DELETE /admin/charts/:id/part-hit-sound error:', err);
        res.status(500).json({ error: 'ヒット音の削除に失敗しました' });
    }
});

app.get('/admin/models', (req, res) => {
    try {
        if (!fs.existsSync(MODELS_DIR)) {
            return res.json([]);
        }
        const names = fs.readdirSync(MODELS_DIR)
            .filter((n) => {
                const low = n.toLowerCase();
                return (
                    low.endsWith('.glb') ||
                    low.endsWith('.obj')
                );
            })
            .map((n) => decodeLikelyMojibakeFilename(n))
            .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
        res.json(names);
    } catch (err) {
        console.error('GET /admin/models error:', err);
        res.status(500).json({ error: 'Failed to list models' });
    }
});

app.get('/admin/model-mtls', (req, res) => {
    try {
        if (!fs.existsSync(MODELS_DIR)) {
            return res.json([]);
        }
        const names = fs.readdirSync(MODELS_DIR)
            .filter((n) => n.toLowerCase().endsWith('.mtl'))
            .map((n) => decodeLikelyMojibakeFilename(n))
            .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
        res.json(names);
    } catch (err) {
        console.error('GET /admin/model-mtls error:', err);
        res.status(500).json({ error: 'Failed to list model MTL files' });
    }
});

app.get('/admin/model-upload-queue', (req, res) => {
    try {
        res.json(getModelUploadQueueStats());
    } catch (err) {
        console.error('GET /admin/model-upload-queue error:', err);
        res.status(500).json({ error: 'Failed to read queue state' });
    }
});

app.get('/admin/storage-files', (req, res) => {
    const store = typeof req.query.store === 'string' ? req.query.store.trim() : '';
    const storeRoot = STORAGE_FILE_STORE_ROOTS[/** @type {keyof typeof STORAGE_FILE_STORE_ROOTS} */ (store)];
    if (!storeRoot) {
        return res.status(400).json({ error: 'Invalid or missing store' });
    }
    if (store === 'chart-bgm' && !CHART_FEATURES_ENABLED) {
        return res.status(503).json({
            error: '譜面機能はこのサーバーでは無効です',
            chartFeaturesEnabled: false
        });
    }
    const relQuery = typeof req.query.path === 'string' ? req.query.path : '';
    const dirAbs = resolvePathUnderStorageRoot(storeRoot, relQuery);
    if (!dirAbs) {
        return res.status(400).json({ error: 'Invalid path' });
    }
    try {
        if (!fs.existsSync(dirAbs)) {
            return res.status(404).json({ error: 'Path not found' });
        }
        const st = fs.statSync(dirAbs);
        if (!st.isDirectory()) {
            return res.status(400).json({ error: 'Not a directory' });
        }
        const rootResolved = path.resolve(storeRoot);
        const names = fs.readdirSync(dirAbs, { withFileTypes: true });
        /** @type {{ name: string, isDirectory: boolean, size: number | null, mtimeMs: number | null }[]} */
        const entries = [];
        for (const d of names) {
            const abs = path.join(dirAbs, d.name);
            let size = null;
            let mtimeMs = null;
            try {
                const fst = fs.statSync(abs);
                mtimeMs = fst.mtimeMs;
                if (fst.isFile()) size = fst.size;
            } catch (_) {
                /* skip stat errors for single entry */
            }
            entries.push({
                name: decodeLikelyMojibakeFilename(d.name),
                isDirectory: d.isDirectory(),
                size,
                mtimeMs,
            });
        }
        entries.sort((a, b) => {
            if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
            return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
        });
        const prefix = path.relative(rootResolved, dirAbs);
        const currentRelative = prefix ? prefix.split(path.sep).join('/') : '';
        res.json({ store, currentRelative, entries });
    } catch (err) {
        console.error('GET /admin/storage-files error:', err);
        res.status(500).json({ error: 'Failed to list directory' });
    }
});

const STORAGE_BULK_DELETE_MAX = 500;

/**
 * ストア内の1ファイルを削除し、キャッシュ無効化用 URL を返す
 * @param {string} store
 * @param {string} storeRoot
 * @param {string} relPath
 * @param {{ missingOk?: boolean }} [options]
 * @returns {{ success: true, invUrls: string[], skipped?: boolean } | { success: false, error: string, invUrls: [] }}
 */
function performStorageFileDelete(store, storeRoot, relPath, options) {
    const missingOk = !!(options && options.missingOk);
    const fileAbs = resolvePathUnderStorageRoot(storeRoot, relPath);
    if (!fileAbs) {
        return { success: false, error: 'Invalid path', invUrls: [] };
    }
    if (!fs.existsSync(fileAbs)) {
        if (missingOk) {
            return { success: true, invUrls: [], skipped: true };
        }
        return { success: false, error: 'File not found', invUrls: [] };
    }
    try {
        const st = fs.statSync(fileAbs);
        if (!st.isFile()) {
            return { success: false, error: 'Only files can be deleted', invUrls: [] };
        }
        /** @type {string[]} */
        const invUrls = [];
        if (store === 'models') {
            const relOne = path.relative(storeRoot, fileAbs).split(path.sep).join('/');
            if (relOne.toLowerCase().endsWith('-prefab-manifest.json')) {
                const { relPaths } = removePrefabBundleFromDisk(storeRoot, relOne);
                for (const rp of relPaths) {
                    invUrls.push(publicAssetUrlForCache('models', rp));
                }
                return { success: true, invUrls, skipped: false };
            }
        }
        fs.unlinkSync(fileAbs);
        const mainRel = path.relative(storeRoot, fileAbs).split(path.sep).join('/');
        invUrls.push(publicAssetUrlForCache(/** @type {'models' | 'pdfs' | 'env' | 'images' | 'chart-bgm'} */ (store), mainRel));
        return { success: true, invUrls, skipped: false };
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { success: false, error: msg || 'Failed to delete file', invUrls: [] };
    }
}

app.delete('/admin/storage-files', (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const store = typeof body.store === 'string' ? body.store.trim() : '';
    const storeRoot = STORAGE_FILE_STORE_ROOTS[/** @type {keyof typeof STORAGE_FILE_STORE_ROOTS} */ (store)];
    if (!storeRoot) {
        return res.status(400).json({ error: 'Invalid or missing store' });
    }
    if (store === 'chart-bgm' && !CHART_FEATURES_ENABLED) {
        return res.status(503).json({
            error: '譜面機能はこのサーバーでは無効です',
            chartFeaturesEnabled: false
        });
    }
    const relPath = typeof body.relativePath === 'string' ? body.relativePath : '';
    const result = performStorageFileDelete(store, storeRoot, relPath, { missingOk: false });
    if (!result.success) {
        if (result.error === 'File not found') {
            return res.status(404).json({ error: result.error });
        }
        if (result.error === 'Invalid path' || result.error === 'Only files can be deleted') {
            return res.status(400).json({ error: result.error });
        }
        console.error('DELETE /admin/storage-files error:', result.error);
        return res.status(500).json({ error: 'Failed to delete file' });
    }
    if (result.invUrls.length) {
        io.emit('asset-invalidate', { urls: result.invUrls });
    }
    res.json({ success: true, deletedUrls: result.invUrls });
});

app.post('/admin/storage-files/bulk-delete', (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const store = typeof body.store === 'string' ? body.store.trim() : '';
    const storeRoot = STORAGE_FILE_STORE_ROOTS[/** @type {keyof typeof STORAGE_FILE_STORE_ROOTS} */ (store)];
    if (!storeRoot) {
        return res.status(400).json({ error: 'Invalid or missing store' });
    }
    if (store === 'chart-bgm' && !CHART_FEATURES_ENABLED) {
        return res.status(503).json({
            error: '譜面機能はこのサーバーでは無効です',
            chartFeaturesEnabled: false
        });
    }
    const raw = body.relativePaths;
    if (!Array.isArray(raw)) {
        return res.status(400).json({ error: 'relativePaths must be an array' });
    }
    const paths = [...new Set(raw.map((p) => (typeof p === 'string' ? p.trim() : '')).filter(Boolean))];
    if (paths.length === 0) {
        return res.status(400).json({ error: 'No paths to delete' });
    }
    if (paths.length > STORAGE_BULK_DELETE_MAX) {
        return res.status(400).json({ error: `Too many paths (max ${STORAGE_BULK_DELETE_MAX})` });
    }
    /** @type {string[]} */
    const allInvUrls = [];
    /** @type {{ relativePath: string, error: string }[]} */
    const errors = [];
    let deletedCount = 0;
    for (const relPath of paths) {
        const result = performStorageFileDelete(store, storeRoot, relPath, { missingOk: true });
        if (result.success) {
            allInvUrls.push(...result.invUrls);
            if (!result.skipped) deletedCount++;
        } else {
            errors.push({ relativePath: relPath, error: result.error });
        }
    }
    if (allInvUrls.length) {
        io.emit('asset-invalidate', { urls: allInvUrls });
    }
    res.json({
        success: errors.length === 0,
        deletedCount,
        errors,
    });
});

app.get('/admin/prefab-manifests', (req, res) => {
    try {
        if (!fs.existsSync(MODELS_DIR)) {
            return res.json([]);
        }
        const names = fs
            .readdirSync(MODELS_DIR)
            .filter((n) => n.toLowerCase().endsWith('-prefab-manifest.json'))
            .map((n) => decodeLikelyMojibakeFilename(n))
            .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
        res.json(names);
    } catch (err) {
        console.error('GET /admin/prefab-manifests error:', err);
        res.status(500).json({ error: 'Failed to list prefab manifests' });
    }
});

app.post('/admin/upload-prefab-zip', uploadPrefabZip.single('zip'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'No file or invalid file' });
    }
    const origName = getSafeUploadedFilename(req, req.file.originalname);
    const ext = path.extname(origName).toLowerCase();
    const mimeOk =
        req.file.mimetype === 'application/zip' ||
        req.file.mimetype === 'application/x-zip-compressed' ||
        req.file.mimetype === 'application/zip-compressed';
    if (ext !== '.zip' && !mimeOk) {
        return res.status(400).json({ error: 'Only .zip is allowed' });
    }
    const glbOpts = parseGlbOptionsFromPrefabBody(req.body);
    if (glbOpts.parseError) {
        return res.status(400).json({ error: glbOpts.parseError });
    }
    const confirm = req.query.confirm === '1';
    const prefabZipOpts =
        USE_S3_MODELS
            ? {
                  maxEdgePx: glbOpts.maxEdgePx,
                  skipTextureResize: glbOpts.skipTextureResize,
                  prefabBaseOverride: `${baseNameFromZipFilename(origName)}_v_${createModelVersionToken()}`,
              }
            : { maxEdgePx: glbOpts.maxEdgePx, skipTextureResize: glbOpts.skipTextureResize };

    try {
        const result = await applyPrefabBundleZipToModels(
            req.file.buffer,
            MODELS_DIR,
            origName,
            confirm,
            prefabZipOpts
        );
        if (!result.success) {
            if (result.status === 409) {
                return res.status(409).json({
                    error: result.error,
                    code: result.code,
                    conflictingFiles: result.conflictingFiles,
                });
            }
            return res.status(result.status).json({ error: result.error, code: result.code });
        }
        if (USE_S3_MODELS && isS3ModelsConfigComplete()) {
            try {
                const absPaths = result.writtenFiles.map((f) => path.join(MODELS_DIR, f));
                await uploadLocalModelsPathsOrRollbackS3(absPaths, MODELS_DIR);
            } catch (eUp) {
                const manBare = String(result.manifestRelativePath || '').replace(/^models\/?/, '').trim();
                if (manBare) {
                    removePrefabBundleFromDisk(MODELS_DIR, manBare);
                }
                console.error('[upload-prefab-zip] S3 upload failed, rolled back:', eUp);
                return res.status(500).json({
                    error:
                        'S3 に反映できなかったためアップロードを破棄しました。環境変数 META_MODELS_S3_BUCKET 等を確認してください。',
                    detail: eUp instanceof Error ? eUp.message : String(eUp),
                    code: 's3_upload_failed',
                });
            }
        }
        const invUrls = result.writtenFiles.map((f) => publicAssetUrlForCache('models', f));
        if (invUrls.length) {
            io.emit('asset-invalidate', { urls: invUrls });
        }
        return res.json({
            success: true,
            prefabManifest: result.manifestRelativePath,
            prefabGroupId: result.prefabGroupId,
            displayName: result.displayName,
            writtenFiles: result.writtenFiles,
            glbCount: result.glbCount,
            textureResizeNotes: result.textureResizeNotes,
        });
    } catch (err) {
        console.error('POST /admin/upload-prefab-zip error:', err);
        return res.status(500).json({
            error: 'Failed to process prefab zip',
            detail: err instanceof Error ? err.message : String(err),
        });
    }
});

app.post('/admin/upload', upload.single('model'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'No file or invalid file' });
    }
    let filename = getSafeUploadedFilename(req, req.file.originalname);
    const ext = path.extname(filename).toLowerCase();
    if (!MODEL_UPLOAD_EXTS.has(ext)) {
        return res.status(400).json({ error: 'File type not allowed for model upload' });
    }
    if (USE_S3_MODELS) {
        filename = insertVersionBeforeExt(filename, createModelVersionToken());
    }
    const destPath = path.join(MODELS_DIR, filename);
    const splitGlbByObjects = req.body?.splitGlbByObjects === '1' || req.body?.splitGlbByObjects === 'true';
    const basenameNoExt = path.basename(filename, ext);
    const existingObjSplits = ext === '.glb' ? listObjectSplitFilesForBase(MODELS_DIR, basenameNoExt) : [];
    const uploadConflict =
        fs.existsSync(destPath) ||
        (splitGlbByObjects && ext === '.glb' && existingObjSplits.length > 0);
    if (!USE_S3_MODELS && uploadConflict && req.query.confirm !== '1') {
        return res.status(409).json({ error: 'file_exists', filename });
    }
    /** @type {string[]} — ディスク確定済み・アップロード連動で消すファイル */
    const pathsToUndoOnFail = [];

    const rollbackAndFail = (eUp, logLabel) => {
        for (const p of pathsToUndoOnFail) tryUnlinkQuiet(p);
        console.error(`${logLabel}:`, eUp);
        return res.status(500).json({
            error: 'モデルのアップロードに失敗しました（外部ストレージへ反映できませんでした）。',
            detail: eUp instanceof Error ? eUp.message : String(eUp),
            code: 's3_upload_failed',
        });
    };

    try {
        if (!fs.existsSync(MODELS_DIR)) {
            fs.mkdirSync(MODELS_DIR, { recursive: true });
        }
        let outBuffer = req.file.buffer;
        let textureResize = null;
        let objectSplit = null;
        let multiSplit = false;
        const skipTextureResize = req.body?.skipTextureResize === '1' || req.body?.skipTextureResize === 'true';
        let textureMaxEdgeParsed = null;
        if (ext === '.glb' && !skipTextureResize) {
            const parsed = parseTextureMaxEdgeFromUploadBody(req.body?.textureMaxEdge);
            if (!parsed.ok) {
                return res.status(400).json({ error: parsed.error });
            }
            textureMaxEdgeParsed = parsed.value;
        }
        if (ext === '.glb') {
            if (skipTextureResize) {
                outBuffer = req.file.buffer;
                textureResize = {
                    applied: false,
                    skippedByClient: true,
                    message: 'テクスチャのリサイズを行わず、オリジナルの GLB を保存しました。',
                };
            } else {
                const pipelineResult = await runGlbTextureResizeQueued(req.file.buffer, {
                    maxEdgePx: textureMaxEdgeParsed,
                });
                outBuffer = pipelineResult.buffer;
                textureResize = pipelineResult.textureResize;
            }
            if (splitGlbByObjects && req.query.confirm === '1') {
                for (const f of listObjectSplitFilesForBase(MODELS_DIR, basenameNoExt)) {
                    try {
                        fs.unlinkSync(path.join(MODELS_DIR, f));
                    } catch (e) {
                        console.warn('[upload] remove old objsplit:', f, e);
                    }
                }
            }
            if (splitGlbByObjects) {
                try {
                    objectSplit = await runGlbObjectSplitFromBuffer(outBuffer, {
                        modelsDir: MODELS_DIR,
                        baseFilename: filename,
                    });
                } catch (e) {
                    console.warn('[upload] object split error:', e);
                    objectSplit = { applied: false, reason: 'error', detail: String(e) };
                }
            }
            multiSplit =
                !!objectSplit?.applied &&
                Array.isArray(objectSplit.partFiles) &&
                objectSplit.partFiles.length >= 2;
            if (multiSplit && fs.existsSync(destPath)) {
                try {
                    fs.unlinkSync(destPath);
                } catch (e) {
                    console.warn('[upload] remove mono glb before objsplit:', destPath, e);
                }
            }
        }
        if (!multiSplit) {
            fs.writeFileSync(destPath, outBuffer);
            pathsToUndoOnFail.push(destPath);
        }
        if (multiSplit && objectSplit.partFiles?.length) {
            for (const f of objectSplit.partFiles) {
                pathsToUndoOnFail.push(path.join(MODELS_DIR, f));
            }
        }

        /** @type {string[]} */
        const invUrls = [];
        if (multiSplit) {
            for (const f of objectSplit.partFiles) {
                invUrls.push(publicAssetUrlForCache('models', f));
            }
        } else {
            invUrls.push(publicAssetUrlForCache('models', filename));
        }

        if (USE_S3_MODELS && isS3ModelsConfigComplete()) {
            try {
                const absList = pathsToUndoOnFail.slice();
                await uploadLocalModelsPathsOrRollbackS3(absList, MODELS_DIR);
            } catch (eUp) {
                rollbackAndFail(eUp, 'POST /admin/upload S3');
            }
        }

        io.emit('asset-invalidate', { urls: invUrls });
        const payload = {
            success: true,
            filename: multiSplit ? objectSplit.partFiles[0] : filename,
        };
        if (USE_S3_MODELS) {
            if (multiSplit && objectSplit?.partFiles) {
                payload.canonicalUrls = objectSplit.partFiles.map((f) =>
                    publicAssetUrlForCache('models', f)
                );
                payload.cdnBaseUrlHint = normalizedCdnBaseUrl();
            } else {
                payload.canonicalUrl = publicAssetUrlForCache('models', filename);
                payload.cdnBaseUrlHint = normalizedCdnBaseUrl();
            }
        }
        if (multiSplit) {
            payload.splitFiles = objectSplit.partFiles;
            payload.objectSplit = { applied: true, partFiles: objectSplit.partFiles };
        } else if (splitGlbByObjects && objectSplit && !objectSplit.applied) {
            payload.objectSplit = {
                applied: false,
                reason: objectSplit.reason,
                detail: objectSplit.detail,
            };
        }
        if (textureResize) {
            payload.textureResize = textureResize;
        }
        if (skipTextureResize && ext === '.glb') {
            payload.textureResizeSkipped = true;
        }
        res.json(payload);
    } catch (err) {
        for (const p of pathsToUndoOnFail) tryUnlinkQuiet(p);
        console.error('POST /admin/upload error:', err);
        res.status(500).json({
            error: 'Failed to save file',
            detail: err instanceof Error ? err.message : String(err),
        });
    }
});

app.get('/admin/pdfs', (req, res) => {
    try {
        if (!fs.existsSync(PDFS_DIR)) {
            return res.json([]);
        }
        const names = fs.readdirSync(PDFS_DIR)
            .filter((n) => n.toLowerCase().endsWith('.pdf'))
            .map((n) => decodeLikelyMojibakeFilename(n));
        res.json(names);
    } catch (err) {
        console.error('GET /admin/pdfs error:', err);
        res.status(500).json({ error: 'Failed to list PDFs' });
    }
});

app.post('/admin/upload-pdf', uploadPdf.single('pdf'), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'No file or invalid file' });
    }
    let filename = getSafeUploadedFilename(req, req.file.originalname);
    if (!filename.toLowerCase().endsWith('.pdf')) {
        filename = filename + '.pdf';
    }
    const ext = path.extname(filename).toLowerCase();
    if (ext !== '.pdf') {
        return res.status(400).json({ error: 'Only .pdf files are allowed' });
    }
    const destPath = path.join(PDFS_DIR, filename);
    if (fs.existsSync(destPath) && req.query.confirm !== '1') {
        return res.status(409).json({ error: 'file_exists', filename });
    }
    try {
        if (!fs.existsSync(PDFS_DIR)) {
            fs.mkdirSync(PDFS_DIR, { recursive: true });
        }
        fs.writeFileSync(destPath, req.file.buffer);
        io.emit('asset-invalidate', { urls: [publicAssetUrlForCache('pdfs', filename)] });
        res.json({ success: true, filename });
    } catch (err) {
        console.error('POST /admin/upload-pdf error:', err);
        res.status(500).json({ error: 'Failed to save file' });
    }
});

/**
 * IBL 用 HDR を ENV_DIR に default.hdr として保存（クライアントは /env/default.hdr を参照）
 */
app.post('/admin/upload-hdr', uploadHdr.single('hdr'), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'No file or invalid file (.hdr / RGBE のみ)' });
    }
    const ext = path.extname(req.file.originalname || '').toLowerCase();
    if (ext !== '.hdr') {
        return res.status(400).json({ error: 'Only .hdr (Radiance RGBE) files are allowed' });
    }
    const destName = 'default.hdr';
    const destPath = path.join(ENV_DIR, destName);
    if (fs.existsSync(destPath) && req.query.confirm !== '1') {
        return res.status(409).json({ error: 'file_exists', filename: destName });
    }
    try {
        if (!fs.existsSync(ENV_DIR)) {
            fs.mkdirSync(ENV_DIR, { recursive: true });
        }
        fs.writeFileSync(destPath, req.file.buffer);
        const url = publicAssetUrlForCache('env', destName);
        io.emit('asset-invalidate', { urls: [url] });
        res.json({ success: true, filename: destName, url });
    } catch (err) {
        console.error('POST /admin/upload-hdr error:', err);
        res.status(500).json({
            error: 'Failed to save HDR',
            detail: err instanceof Error ? err.message : String(err),
        });
    }
});

// Public read-only worlds (for main app index.html)
app.get('/api/worlds', (req, res) => {
    try {
        const worlds = readWorlds();
        res.json(worlds);
    } catch (err) {
        console.error('GET /api/worlds error:', err);
        res.status(500).json({ error: 'Failed to read worlds' });
    }
});

app.get('/api/client-config', (req, res) => {
    let cdnHostname = null;
    if (USE_S3_MODELS) {
        try {
            const cu = normalizedCdnBaseUrl();
            if (cu) cdnHostname = new URL(/^\w+:\/\//.test(cu) ? cu : `https://${cu}`).hostname;
        } catch {
            /* ignore */
        }
    }
    res.json({
        chartFeaturesEnabled: CHART_FEATURES_ENABLED,
        assetModels: {
            mode: USE_S3_MODELS ? 'cdn' : 'local',
            cdnBaseUrl: USE_S3_MODELS ? normalizedCdnBaseUrl() : null,
            cdnHostname,
        },
    });
});

/** CloudFront で保護されている CDN 上のアセットへ GET するための署名 URL をまとめて発行する */
app.post('/api/metaverse/sign-asset-urls', async (req, res) => {
    try {
        if (!USE_S3_MODELS || !isS3ModelsConfigComplete()) {
            return res.status(503).json({ error: 'signing_unavailable' });
        }
        if (!verifySocketAuthToken(getSocketAuthTokenFromHttp(req))) {
            return res.status(401).json({ error: 'unauthorized' });
        }
        const urlsIn = req.body?.urls;
        if (!Array.isArray(urlsIn) || urlsIn.length === 0) {
            return res.status(400).json({ error: 'urls array required' });
        }
        const cdnOrigin = normalizedCdnBaseUrl();
        let allowedHost = '';
        try {
            allowedHost = new URL(/^\w+:\/\//.test(cdnOrigin) ? cdnOrigin : `https://${cdnOrigin}`).hostname;
        } catch {
            return res.status(500).json({ error: 'invalid_cdn_config' });
        }
        const max = Math.min(urlsIn.length, 64);
        const signed = /** @type {Record<string, string>} */ ({});
        for (let i = 0; i < max; i++) {
            const raw = urlsIn[i];
            if (typeof raw !== 'string' || !raw.trim()) continue;
            const uClean = raw.trim().split('#')[0];
            let parsed;
            try {
                parsed = new URL(uClean);
            } catch {
                return res.status(400).json({ error: `invalid url at ${i}` });
            }
            if (parsed.protocol !== 'https:') {
                return res.status(400).json({ error: 'https_only' });
            }
            const phost = parsed.hostname.replace(/:\d+$/, '');
            if (phost !== allowedHost.replace(/:\d+$/, '')) {
                return res.status(400).json({ error: `host mismatch at ${i}` });
            }
            signed[uClean] = await signCloudFrontGetUrl(uClean);
        }
        return res.json({ signed });
    } catch (e) {
        console.error('POST /api/metaverse/sign-asset-urls:', e);
        return res.status(500).json({
            error: 'sign_failed',
            detail: e instanceof Error ? e.message : String(e),
        });
    }
});

app.use('/api/charts', (req, res, next) => {
    if (CHART_FEATURES_ENABLED) return next();
    const p = req.path || '';
    if (req.method === 'GET' && (p === '/' || p === '')) {
        return res.json({});
    }
    if (req.method === 'GET' && /\/[^/]+\/ranking\/?$/.test(p)) {
        return res.json([]);
    }
    res.status(503).json({
        error: '譜面機能はこのサーバーでは無効です',
        chartFeaturesEnabled: false
    });
});

app.get('/api/charts', (req, res) => {
    try {
        const charts = readCharts();
        res.json(charts);
    } catch (err) {
        console.error('GET /api/charts error:', err);
        res.status(500).json({ error: 'Failed to read charts' });
    }
});

/** 譜面別スコアランキング（メモリ保持）。{ chartId: [ { username, score } ] } 降順 */
const chartScores = {};
const CHART_SCORE_USERNAME_MAX_LEN = 64;

app.post('/api/charts/:id/score', chartScoreIpLimiter, (req, res) => {
    const id = req.params.id;
    const charts = readCharts();
    if (!charts || typeof charts !== 'object' || !Object.prototype.hasOwnProperty.call(charts, id)) {
        return res.status(404).json({ error: 'Chart not found' });
    }
    const { username, score } = req.body || {};
    const scoreNum = typeof score === 'number' ? score : parseInt(score, 10);
    if (Number.isNaN(scoreNum) || scoreNum < 0) {
        return res.status(400).json({ error: 'Invalid score' });
    }
    const name = (typeof username === 'string' && username.trim()) ? username.trim() : 'プレイヤー';
    if (name.length > CHART_SCORE_USERNAME_MAX_LEN) {
        return res.status(400).json({ error: 'username too long' });
    }
    if (!chartScores[id]) chartScores[id] = [];
    chartScores[id].push({ username: name, score: scoreNum });
    chartScores[id].sort((a, b) => b.score - a.score);
    const maxEntries = 100;
    if (chartScores[id].length > maxEntries) chartScores[id] = chartScores[id].slice(0, maxEntries);
    res.json({ success: true });
});

app.get('/api/charts/:id/ranking', (req, res) => {
    const id = req.params.id;
    const list = chartScores[id] || [];
    const top = list.slice(0, 10);
    res.json(top);
});

app.get('/admin/stats', (req, res) => {
    let totalPlayers = 0;
    roomStates.forEach(roomState => {
        totalPlayers += roomState.players.size;
    });
    
    const traffic = getTotalTrafficStats();
    const loadMetrics = getServerLoadMetrics();
    const vcPortInfo = getVCPortInfo();
    const pdfVcPortInfo = getPdfVCPortInfo();
    const videoVcPortInfo = getVideoVCPortInfo();

    res.json({
        totalPlayers,
        totalRooms: roomStates.size,
        activeVCRooms: vcRouters.size,
        activeVCPeers: vcPeers.size,
        cpuUsagePercent: loadMetrics.cpuUsagePercent,
        ramUsagePercent: loadMetrics.ramUsagePercent,
        commPerSecond: loadMetrics.commPerSecond,
        degradationIndex: loadMetrics.degradationIndex,
        bandwidthLimitBps: BANDWIDTH_LIMIT_BPS,
        bandwidthLimitMbps: BANDWIDTH_LIMIT_MBPS,
        traffic: {
            bytesReceived: traffic.bytesReceived,
            bytesSent: traffic.bytesSent,
            packetsReceived: traffic.packetsReceived,
            packetsSent: traffic.packetsSent,
            bytesReceivedFormatted: formatBytes(traffic.bytesReceived),
            bytesSentFormatted: formatBytes(traffic.bytesSent)
        },
        vcPorts: {
            uniquePorts: vcPortInfo.uniquePorts,
            portCount: vcPortInfo.uniquePorts.length,
            portDetails: vcPortInfo.portDetails
        },
        pdfVcPorts: {
            uniquePorts: pdfVcPortInfo.uniquePorts,
            portCount: pdfVcPortInfo.uniquePorts.length,
            portDetails: pdfVcPortInfo.portDetails
        },
        videoVcPorts: {
            uniquePorts: videoVcPortInfo.uniquePorts,
            portCount: videoVcPortInfo.uniquePorts.length,
            portDetails: videoVcPortInfo.portDetails
        },
        workers: workers.length,
        chartFeaturesEnabled: CHART_FEATURES_ENABLED
    });
});

app.get('/admin/players', (req, res) => {
    const players = [];
    
    const now = Date.now();
    roomStates.forEach((roomState, roomId) => {
        roomState.players.forEach((player, socketId) => {
            const stats = trafficStats.get(socketId);
            const peer = vcPeers.get(socketId);
            const connectedAt = stats ? stats.connectedAt : Date.now();
            const connectedDuration = Date.now() - connectedAt;
            const pingData = playerPings.get(socketId);
            const pingFresh = pingData && (now - pingData.reportedAt) < PING_STALE_MS;
            const pingMs = pingFresh ? pingData.pingMs : null;
            const fpsSample = pingFresh && pingData.fpsSample != null ? pingData.fpsSample : null;
            const perfTier = pingFresh && pingData.effectiveTier ? pingData.effectiveTier : null;

            const socket = io.sockets.sockets.get(player.id);
            const role = socket?.data?.role || null;

            players.push({
                socketId: player.id,
                username: player.username,
                room: roomId,
                world: player.world,
                position: player.position,
                role,
                connectedAt: new Date(connectedAt).toISOString(),
                connectedDuration: Math.floor(connectedDuration / 1000), // seconds
                hasVC: !!peer,
                vcMicOn: !!(peer && peer.sendTransport),
                vcSpeakerOn: !!(peer && peer.recvTransport),
                pingMs,
                fpsSample,
                perfTier,
                traffic: stats ? {
                    bytesReceived: stats.bytesReceived,
                    bytesSent: stats.bytesSent,
                    packetsReceived: stats.packetsReceived,
                    packetsSent: stats.packetsSent
                } : null
            });
        });
    });
    
    res.json(players);
});

app.post('/admin/kick', (req, res) => {
    const { socketId } = req.body;
    if (!socketId) {
        return res.status(400).json({ error: 'socketId is required' });
    }
    
    const targetSocket = io.sockets.sockets.get(socketId);
    if (targetSocket) {
        // Send kick notification before disconnecting
        targetSocket.emit('admin-kicked', { message: '管理者によってキックされました。' });
        // Small delay to ensure message is sent before disconnect
        setTimeout(() => {
            targetSocket.disconnect(true);
        }, 100);
        res.json({ success: true, message: `Player ${socketId} kicked` });
    } else {
        res.status(404).json({ error: 'Player not found' });
    }
});

app.post('/admin/mute-mic', async (req, res) => {
    const { socketId } = req.body;
    if (!socketId) {
        return res.status(400).json({ error: 'socketId is required' });
    }
    
    const peer = vcPeers.get(socketId);
    if (peer && peer.sendTransport) {
        // Close all producers
        for (const [producerId, producer] of peer.producers) {
            producer.close();
            peer.producers.delete(producerId);
            io.to(peer.roomId).emit('vc-producer-closed', { producerId });
        }
        // Close sendTransport
        peer.sendTransport.close();
        peer.sendTransport = null;
        res.json({ success: true, message: `Mic muted for player ${socketId}` });
    } else {
        res.status(404).json({ error: 'Player not found or mic not active' });
    }
});

app.post('/admin/send-alert', (req, res) => {
    const { socketId, message } = req.body;
    if (!socketId || !message) {
        return res.status(400).json({ error: 'socketId and message are required' });
    }
    
    const targetSocket = io.sockets.sockets.get(socketId);
    if (targetSocket) {
        targetSocket.emit('admin-alert', { message });
        res.json({ success: true, message: `Alert sent to player ${socketId}` });
    } else {
        res.status(404).json({ error: 'Player not found' });
    }
});

/** セレクター (@a / @ユーザー名 / @SocketID) から対象ソケットの配列を返す。無効な場合は null。 */
function getTargetsForSelector(selector) {
    if (!selector || !selector.startsWith('@')) return null;
    const getUsernameForSocket = (s) => {
        const room = s.data.currentRoom;
        if (!room) return 'Guest';
        const roomState = getRoomState(room);
        const player = roomState?.players.get(s.id);
        return player?.username || 'Guest';
    };
    if (selector === '@a') {
        return Array.from(io.sockets.sockets.values());
    }
    const value = selector.slice(1);
    const byId = io.sockets.sockets.get(value);
    if (byId) return [byId];
    const targets = [];
    for (const s of io.sockets.sockets.values()) {
        if (getUsernameForSocket(s) === value) targets.push(s);
    }
    return targets;
}

// Admin: Command execution (e.g. tp @a world x y z, tell @a message)
app.post('/admin/command', async (req, res) => {
    const { command } = req.body;
    if (!command || typeof command !== 'string') {
        return res.status(400).json({ success: false, error: 'コマンドを入力してください' });
    }
    logWithStorage('info', '> ' + command);
    const parts = command.trim().split(/\s+/);
    const cmd = (parts[0] || '').toLowerCase();
    if (cmd === 'tp') {
        if (parts.length < 6) {
            logWithStorage('error', '使い方: tp [@a|@ユーザー名|@SocketID] (ワールド名) (x) (y) (z)');
            return res.json({ success: false, error: '使い方: tp [@a|@ユーザー名|@SocketID] (ワールド名) (x) (y) (z)' });
        }
        const selector = parts[1];
        const worldId = parts[2];
        const x = parseFloat(parts[3]);
        const y = parseFloat(parts[4]);
        const z = parseFloat(parts[5]);
        if (isNaN(x) || isNaN(y) || isNaN(z)) {
            logWithStorage('error', '座標は数値で指定してください');
            return res.json({ success: false, error: '座標は数値で指定してください' });
        }
        const targets = getTargetsForSelector(selector);
        if (!targets) {
            logWithStorage('error', 'セレクターは @a / @ユーザー名 / @SocketID の形式で指定してください');
            return res.json({ success: false, error: 'セレクターは @a / @ユーザー名 / @SocketID の形式で指定してください' });
        }
        if (targets.length === 0) {
            logWithStorage('error', '対象のプレイヤーがいません');
            return res.json({ success: false, error: '対象のプレイヤーがいません' });
        }
        const worlds = readWorlds();
        if (!worlds[worldId]) {
            const err = `ワールド "${worldId}" は存在しません`;
            logWithStorage('error', err);
            return res.json({ success: false, error: err });
        }
        const position = { x, y, z };
        const teleportedNames = [];
        for (const targetSocket of targets) {
            const targetSocketId = targetSocket.id;
            const oldRoom = targetSocket.data.currentRoom;
            const newRoom = worldId;
            if (oldRoom !== newRoom) {
                releaseAllAircraftForPlayerInRoom(io, oldRoom, targetSocketId);
                const oldRoomState = getRoomState(oldRoom);
                const oldPlayer = oldRoomState.players.get(targetSocketId);
                oldRoomState.players.delete(targetSocketId);
                targetSocket.leave(oldRoom);
                io.to(oldRoom).emit('player-left', targetSocketId);
                targetSocket.join(newRoom);
                targetSocket.data.currentRoom = newRoom;
                const newRoomState = getRoomState(newRoom);
                const playerState = {
                    id: targetSocketId,
                    username: oldPlayer ? oldPlayer.username : 'Guest',
                    position,
                    rotation: { x: 0, y: 0, z: 0 },
                    quaternion: { x: 0, y: 0, z: 0, w: 1 },
                    world: newRoom,
                    timestamp: 0,
                    adminInvisible: !!(oldPlayer && oldPlayer.adminInvisible),
                    animState: normalizePlayerAnimState(oldPlayer?.animState) || 'idle',
                    pilotingAircraftId: null,
                    serverLowAssistPrev: null,
                    serverLowAssistAt: Date.now()
                };
                newRoomState.players.set(targetSocketId, playerState);
                io.to(newRoom).emit('player-joined', playerState);
                await cleanupVCPeer(targetSocketId);
                targetSocket.emit('vc-room-changed', { roomId: newRoom });
                await cleanupVideoVCPeer(targetSocketId);
                targetSocket.emit('video-vc-room-changed', { roomId: newRoom });
            } else {
                releaseAllAircraftForPlayerInRoom(io, newRoom, targetSocketId);
                const roomState = getRoomState(newRoom);
                const player = roomState.players.get(targetSocketId);
                if (player) {
                    player.position = position;
                    player.pilotingAircraftId = null;
                }
            }
            setPhysicsAssistGrace(targetSocket);
            targetSocket.emit('admin-tp', { world: worldId, position });
            const roomState = getRoomState(targetSocket.data.currentRoom);
            const name = roomState?.players.get(targetSocketId)?.username || targetSocketId;
            teleportedNames.push(name);
            console.log(`[ADMIN] tp: ${targetSocketId} -> ${worldId} (${x}, ${y}, ${z})`);
        }
        const tpMsg = `${teleportedNames.join(', ')} を ${worldId} (${x}, ${y}, ${z}) へテレポートしました`;
        logWithStorage('info', tpMsg);
        res.json({ success: true, message: tpMsg });
    } else if (cmd === 'tell') {
        if (parts.length < 3) {
            logWithStorage('error', '使い方: tell [@a|@ユーザー名|@SocketID] [内容文]');
            return res.json({ success: false, error: '使い方: tell [@a|@ユーザー名|@SocketID] [内容文]' });
        }
        const selector = parts[1];
        const message = parts.slice(2).join(' ');
        if (!message) {
            logWithStorage('error', '内容文を入力してください');
            return res.json({ success: false, error: '内容文を入力してください' });
        }
        const targets = getTargetsForSelector(selector);
        if (!targets) {
            logWithStorage('error', 'セレクターは @a / @ユーザー名 / @SocketID の形式で指定してください');
            return res.json({ success: false, error: 'セレクターは @a / @ユーザー名 / @SocketID の形式で指定してください' });
        }
        for (const s of targets) {
            s.emit('admin-alert', { message });
        }
        const tellMsg = `${targets.length} 人にメッセージを送信しました`;
        logWithStorage('info', tellMsg);
        res.json({ success: true, message: tellMsg });
    } else if (cmd === 'ban') {
        if (parts.length < 2) {
            logWithStorage('error', '使い方: ban [@a|@ユーザー名|@SocketID] [reason]');
            return res.json({ success: false, error: '使い方: ban [@a|@ユーザー名|@SocketID] [reason]' });
        }
        const selector = parts[1];
        const reason = parts.slice(2).join(' ').trim() || '管理者によってBANされました。';
        const targets = getTargetsForSelector(selector);
        if (!targets) {
            logWithStorage('error', 'セレクターは @a / @ユーザー名 / @SocketID の形式で指定してください');
            return res.json({ success: false, error: 'セレクターは @a / @ユーザー名 / @SocketID の形式で指定してください' });
        }
        if (targets.length === 0) {
            logWithStorage('error', '対象のプレイヤーがいません');
            return res.json({ success: false, error: '対象のプレイヤーがいません' });
        }
        const getUsernameForSocket = (s) => {
            const room = s.data.currentRoom;
            if (!room) return 'Guest';
            const roomState = getRoomState(room);
            const player = roomState?.players.get(s.id);
            return player?.username || 'Guest';
        };
        const kickedNames = [];
        for (const s of targets) {
            kickedNames.push(getUsernameForSocket(s));
            s.emit('admin-kicked', { message: reason });
            setTimeout(() => s.disconnect(true), 100);
            console.log(`[ADMIN] Ban (kick): ${s.id}, reason: ${reason}`);
        }
        const banMsg = `${kickedNames.join(', ')} をBANしました`;
        logWithStorage('info', banMsg);
        res.json({ success: true, message: banMsg });
    } else {
        const err = `不明なコマンド: ${cmd}`;
        logWithStorage('error', err);
        res.json({ success: false, error: err });
    }
});

app.get('/admin/logs', (req, res) => {
    const limit = parseInt(req.query.limit) || 100;
    const logs = serverLogs.slice(-limit);
    res.json(logs);
});

app.get('/admin/chat-logs', (req, res) => {
    const roomId = req.query.room;
    const limit = parseInt(req.query.limit) || 100;

    let logs;
    if (roomId) {
        logs = getChatLogs(roomId, limit);
    } else {
        logs = getAllChatLogs(limit);
    }

    res.json(logs);
});

app.get('/admin/user-sessions', (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 50));
        const { sessions, total } = getSessionsPaginated(page, limit);
        res.json({ sessions, total });
    } catch (err) {
        console.error('GET /admin/user-sessions error:', err);
        sendAdminServerError(res, err);
    }
});

app.get('/admin/user-sessions/by-username/:username', (req, res) => {
    try {
        const username = req.params.username;
        if (!username) return res.status(400).json({ error: 'username required' });
        const session = getLatestSessionByUsername(username);
        res.json(session || {});
    } catch (err) {
        console.error('GET /admin/user-sessions/by-username error:', err);
        sendAdminServerError(res, err);
    }
});

// Admin: User management (students / teachers)
app.get('/admin/users/students', (req, res) => {
    try {
        res.json(listStudents());
    } catch (err) {
        console.error('GET /admin/users/students error:', err);
        sendAdminServerError(res, err);
    }
});

app.get('/admin/users/teachers', (req, res) => {
    try {
        res.json(listTeachers());
    } catch (err) {
        console.error('GET /admin/users/teachers error:', err);
        sendAdminServerError(res, err);
    }
});

app.post('/admin/users/student', (req, res) => {
    const { username, password, displayName } = req.body || {};
    if (!username || !password) {
        return res.status(400).json({ error: 'username and password required' });
    }
    try {
        const user = registerStudent(username, password, displayName);
        res.json({ success: true, user: { id: user.id, username: user.username, displayName: user.displayName } });
    } catch (e) {
        if (e.code === 'SQLITE_CONSTRAINT_UNIQUE') {
            return res.status(409).json({ error: 'username_exists' });
        }
        res.status(500).json({ error: e.message });
    }
});

app.post('/admin/users/teacher', (req, res) => {
    const { username, password, displayName } = req.body || {};
    if (!username || !password) {
        return res.status(400).json({ error: 'username and password required' });
    }
    try {
        const user = registerTeacher(username, password, displayName);
        res.json({ success: true, user: { id: user.id, username: user.username, displayName: user.displayName } });
    } catch (e) {
        if (e.code === 'SQLITE_CONSTRAINT_UNIQUE') {
            return res.status(409).json({ error: 'username_exists' });
        }
        res.status(500).json({ error: e.message });
    }
});

app.put('/admin/users/student/:id', (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'invalid id' });
    const { username, displayName, password } = req.body || {};
    try {
        const user = updateStudent(id, { username, displayName, password });
        if (!user) return res.status(404).json({ error: 'not_found' });
        res.json({ success: true, user: { id: user.id, username: user.username, displayName: user.displayName } });
    } catch (e) {
        if (e.code === 'SQLITE_CONSTRAINT_UNIQUE') {
            return res.status(409).json({ error: 'username_exists' });
        }
        res.status(500).json({ error: e.message });
    }
});

app.put('/admin/users/teacher/:id', (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'invalid id' });
    const { username, displayName, password } = req.body || {};
    try {
        const user = updateTeacher(id, { username, displayName, password });
        if (!user) return res.status(404).json({ error: 'not_found' });
        res.json({ success: true, user: { id: user.id, username: user.username, displayName: user.displayName } });
    } catch (e) {
        if (e.code === 'SQLITE_CONSTRAINT_UNIQUE') {
            return res.status(409).json({ error: 'username_exists' });
        }
        res.status(500).json({ error: e.message });
    }
});

app.delete('/admin/users/student/:id', (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'invalid id' });
    const ok = deleteStudent(id);
    if (!ok) return res.status(404).json({ error: 'not_found' });
    res.json({ success: true });
});

app.delete('/admin/users/teacher/:id', (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'invalid id' });
    const ok = deleteTeacher(id);
    if (!ok) return res.status(404).json({ error: 'not_found' });
    res.json({ success: true });
});

function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
}

// Start server
(async () => {
    ensureWorldsFile();
    if (CHART_FEATURES_ENABLED) {
        ensureChartsFile();
    }
    initDb();
    initUserSessionsDb();
    // Initialize mediasoup workers (room VC + PDF VC)
    await createWorkers();
    await createPdfWorkers();
    await createVideoVcWorkers();

    if (USE_S3_MODELS && isS3ModelsConfigComplete()) {
        try {
            const r = await syncLocalModelsToS3OnStartup(MODELS_DIR);
            console.log('[s3-sync] startup', r);
        } catch (e) {
            console.error('[s3-sync] startup failed:', e);
        }
    }

    const protocol = hasSsl ? 'https' : 'http';

    httpServer.listen(PORT, HOST, () => {
    console.log(`Server running on ${protocol}://localhost:${PORT}`);
    if (useReverseProxy) {
        console.log(
            'USE_REVERSE_PROXY: Node serves HTTP only; terminate TLS at nginx/Caddy etc.'
        );
        if (requireSecureHttp) {
            console.log('REQUIRE_SECURE_HTTP: rejecting requests without HTTPS (trust X-Forwarded-Proto via trust proxy).');
        }
        if (proxyDomainPortMap.size > 0) {
            const lines = [...proxyDomainPortMap.entries()]
                .map(([h, p]) => `  ${h} -> ${p}`)
                .join('\n');
            console.log(`PROXY_DOMAIN_PORT_MAP:\n${lines}`);
        }
        if (PROXY_SERVICE_DOMAIN) {
            console.log(`PROXY_SERVICE_DOMAIN (this process): ${PROXY_SERVICE_DOMAIN}`);
        }
    }
    const lanIps = getLanIps();
    if (lanIps.length > 0) {
        console.log(`LAN access: ${lanIps.map(ip => `${protocol}://${ip}:${PORT}`).join(', ')}`);
        if (HOST === '0.0.0.0' && !useReverseProxy) {
            console.log('External access: forward TCP port ' + PORT + ' on your router to this machine (see EXTERNAL_ACCESS.md).');
        }
        if (!MEDIASOUP_ANNOUNCED_IP && lanIps.length > 0) {
            console.warn(`[VC] MEDIASOUP_ANNOUNCED_IP not set. Set to your LAN IP (e.g. ${lanIps[0]}) for WebRTC/voice/video on LAN.`);
        }
        if (MEDIASOUP_ANNOUNCED_LAN_IP) {
            console.log(`[VC] MEDIASOUP_ANNOUNCED_LAN_IP=${MEDIASOUP_ANNOUNCED_LAN_IP} (extra ICE for same-LAN clients)`);
        }
    }
    if (hasSsl) {
        console.log('HTTPS is enabled (SSL_CERT_PATH / SSL_KEY_PATH).');
        if (requireSecureHttp) {
            console.log('REQUIRE_SECURE_HTTP: non-TLS connections to this port are rejected.');
        }
    }
    if (hasSsl && PORT_HTTP_REDIRECT > 0) {
        const redirectServer = http.createServer((req, res) => {
            const host = (req.headers.host || 'localhost').split(':')[0];
            res.writeHead(302, { Location: `https://${host}:${PORT}${req.url}` });
            res.end();
        });
        redirectServer.listen(PORT_HTTP_REDIRECT, HOST, () => {
            console.log(`HTTP redirect server on port ${PORT_HTTP_REDIRECT} -> ${protocol}:${PORT}`);
        });
    }
    console.log(`Players will sync at 30fps`);
    console.log(`mediasoup VC enabled with ${workers.length} workers; PDF VC with ${pdfWorkers.length} workers`);
    console.log(`ENABLE_CHART_FEATURES (太鼓・譜面): ${CHART_FEATURES_ENABLED ? '有効' : '無効'}`);
    console.log(`VC_DEBUG_STATS: ${VC_DEBUG_STATS ? 'ENABLED' : 'DISABLED'} (env=${process.env.VC_DEBUG_STATS})`);
    console.log(`Admin panel available at ${protocol}://localhost:${PORT}/admin.html`);
    if (CHART_FEATURES_ENABLED) {
        setImmediate(() => {
            runChartBgmWavMigration(CHART_BGM_DIR).catch((e) => {
                console.warn('[chart-bgm] WAV migration error:', e?.message || e);
            });
        });
    }
    });
})();