// lib/server-maintenance.js — 管理者が手動で ON にするメンテナンス告知（接続は維持）
import fs from 'node:fs';
import { STORAGE_PATHS } from '../config/storage-paths.js';

/** @type {string} */
export const SERVER_MAINTENANCE_DEFAULT_MESSAGE =
    '現在メンテナンス中です。接続が不安定になったり\n一部の機能で不具合が発生する可能性があります。';

let maintenanceActive = false;
/** @type {string} */
let maintenanceMessage = SERVER_MAINTENANCE_DEFAULT_MESSAGE;
let loadedFromDisk = false;

/**
 * ディスクからメンテナンス状態を読み込む（起動時に1回呼ぶ）
 * @returns {{ active: boolean, message: string }}
 */
export function initServerMaintenance() {
    if (loadedFromDisk) return getServerMaintenanceAdminStatus();

    const filePath = STORAGE_PATHS.SERVER_MAINTENANCE_PATH;
    try {
        if (fs.existsSync(filePath)) {
            const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            maintenanceActive = !!parsed?.active;
            const msg = typeof parsed?.message === 'string' ? parsed.message.trim() : '';
            maintenanceMessage = msg || SERVER_MAINTENANCE_DEFAULT_MESSAGE;
        }
    } catch (e) {
        console.warn('[server-maintenance] read failed, using defaults:', e instanceof Error ? e.message : e);
        maintenanceActive = false;
        maintenanceMessage = SERVER_MAINTENANCE_DEFAULT_MESSAGE;
    }

    loadedFromDisk = true;
    return getServerMaintenanceAdminStatus();
}

/**
 * メンテナンス状態をディスクへ保存する
 * @returns {void}
 */
function persistServerMaintenance() {
    const filePath = STORAGE_PATHS.SERVER_MAINTENANCE_PATH;
    const payload = {
        active: maintenanceActive,
        message: maintenanceMessage,
    };
    const tmpPath = `${filePath}.tmp.${Date.now()}`;
    fs.writeFileSync(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    fs.renameSync(tmpPath, filePath);
}

/**
 * @returns {{ active: boolean, message: string | null }}
 */
export function getServerMaintenancePublicStatus() {
    return {
        active: maintenanceActive,
        message: maintenanceActive ? maintenanceMessage : null,
    };
}

/**
 * @returns {{ active: boolean, message: string }}
 */
export function getServerMaintenanceAdminStatus() {
    return {
        active: maintenanceActive,
        message: maintenanceMessage,
    };
}

/**
 * @param {import('socket.io').Socket} socket
 * @returns {boolean}
 */
function shouldReceiveServerMaintenanceStatus(socket) {
    return !socket.data?.isBenchBot;
}

/**
 * @param {import('socket.io').Server} io
 * @returns {void}
 */
export function broadcastServerMaintenanceStatus(io) {
    if (!io) return;
    const payload = getServerMaintenancePublicStatus();
    for (const socket of io.sockets.sockets.values()) {
        if (!shouldReceiveServerMaintenanceStatus(socket)) continue;
        socket.emit('server-maintenance-status', payload);
    }
}

/**
 * @param {import('socket.io').Socket} socket
 * @returns {void}
 */
export function emitServerMaintenanceStatusToSocket(socket) {
    if (!socket || !shouldReceiveServerMaintenanceStatus(socket)) return;
    socket.emit('server-maintenance-status', getServerMaintenancePublicStatus());
}

/**
 * @param {{ active: boolean, message?: string | null, io?: import('socket.io').Server | null }} opts
 * @returns {{ active: boolean, message: string }}
 */
export function setServerMaintenance(opts) {
    const { active, io = null } = opts;
    maintenanceActive = !!active;
    maintenanceMessage = SERVER_MAINTENANCE_DEFAULT_MESSAGE;
    try {
        persistServerMaintenance();
    } catch (e) {
        console.error('[server-maintenance] persist failed:', e instanceof Error ? e.message : e);
        throw e;
    }
    if (io) broadcastServerMaintenanceStatus(io);
    return getServerMaintenanceAdminStatus();
}
