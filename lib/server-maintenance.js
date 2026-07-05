// lib/server-maintenance.js — 管理者が手動で ON にするメンテナンス告知（接続は維持）

/** @type {string} */
export const SERVER_MAINTENANCE_DEFAULT_MESSAGE =
    '現在メンテナンス作業中です。接続は維持されますが、しばらくお待ちください。';

let maintenanceActive = false;
/** @type {string} */
let maintenanceMessage = SERVER_MAINTENANCE_DEFAULT_MESSAGE;

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
    const { active, message, io = null } = opts;
    maintenanceActive = !!active;
    if (typeof message === 'string') {
        const trimmed = message.trim();
        if (trimmed) maintenanceMessage = trimmed;
    }
    if (io) broadcastServerMaintenanceStatus(io);
    return getServerMaintenanceAdminStatus();
}
