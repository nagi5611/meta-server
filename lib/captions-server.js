// lib/captions-server.js — サーバー側の字幕コーディネータ
// - ルームごとの「字幕リスナー」集合を管理し、0->1 / 1->0 で話者へ capture 開始/停止を指示（コスト最適化）
// - 話者ごとの STT セッションを遅延生成し、interim/final を同じワールドへブロードキャスト、final を DB 保存
import { isCaptionsRuntimeReady, getCaptionInterimThrottleMs } from './captions-config.js';
import { createCaptionSession } from './speech-captions.js';
import { insertCaptionLog } from '../db/captions-log.js';

/** roomId -> Set<socketId>（字幕を見たい聞き手） */
const listenersByRoom = new Map();
/** socketId -> { session, roomId, username, lastInterimAt } */
const sessions = new Map();

/** 1 チャンクの最大バイト数（濫用防止）。16k mono 16bit なら 100ms=3200B、余裕を見て 64KB。 */
const MAX_CHUNK_BYTES = 64 * 1024;

/** @returns {boolean} 字幕機能が実行時に有効か */
export function captionsReady() {
    return isCaptionsRuntimeReady();
}

/**
 * @param {string} roomId
 * @returns {number}
 */
function roomListenerCount(roomId) {
    const s = listenersByRoom.get(roomId);
    return s ? s.size : 0;
}

/**
 * 聞き手の字幕購読状態を登録/解除。0->1 で room へ stt-capture-start、1->0 で stt-capture-stop。
 * @param {import('socket.io').Server} io
 * @param {string} roomId
 * @param {string} socketId
 * @param {boolean} enabled
 */
export function setListener(io, roomId, socketId, enabled) {
    if (!roomId) return;
    let set = listenersByRoom.get(roomId);
    if (!set) { set = new Set(); listenersByRoom.set(roomId, set); }
    const before = set.size;
    if (enabled) set.add(socketId);
    else set.delete(socketId);
    const after = set.size;
    if (before === 0 && after > 0) io.to(roomId).emit('stt-capture-start');
    if (before > 0 && after === 0) io.to(roomId).emit('stt-capture-stop');
    if (set.size === 0) listenersByRoom.delete(roomId);
}

/**
 * 既にリスナーがいる部屋で話者がマイク ON にした際、その話者にだけ capture 開始を伝える。
 * @param {import('socket.io').Server} io
 * @param {string} roomId
 * @param {string} socketId
 */
export function notifySpeakerIfListeners(io, roomId, socketId) {
    if (roomListenerCount(roomId) > 0) io.to(socketId).emit('stt-capture-start');
}

/**
 * @param {import('socket.io').Server} io
 * @param {import('socket.io').Socket} socket
 * @param {(socket:any)=>string} getDisplayName
 * @returns {Promise<{session:any, roomId:string, username:string, lastInterimAt:number}>}
 */
async function ensureSession(io, socket, getDisplayName) {
    const existing = sessions.get(socket.id);
    if (existing?.session) return existing;

    const roomId = socket.data.currentRoom;
    const username = getDisplayName(socket);
    const entry = existing || { session: null, roomId, username, lastInterimAt: 0 };
    sessions.set(socket.id, entry);

    const throttleMs = getCaptionInterimThrottleMs();
    const emitCaption = (text, isFinal) => {
        const rid = socket.data.currentRoom || roomId;
        io.to(rid).emit('stt-caption', {
            peerId: socket.id,
            username: entry.username,
            text,
            isFinal,
        });
    };

    const session = await createCaptionSession({
        onInterim: (text) => {
            const now = Date.now();
            if (now - entry.lastInterimAt < throttleMs) return;
            entry.lastInterimAt = now;
            emitCaption(text, false);
        },
        onFinal: (text) => {
            emitCaption(text, true);
            try {
                insertCaptionLog({
                    roomId: socket.data.currentRoom || roomId,
                    peerId: socket.id,
                    username: entry.username,
                    transcript: text,
                });
            } catch (e) {
                console.error('[captions] insertCaptionLog failed:', e?.message || e);
            }
        },
        onError: (err) => {
            console.error(`[captions] STT error (${socket.id}):`, err?.message || err);
        },
    });
    entry.session = session;
    return entry;
}

/**
 * 話者から届いた PCM チャンクを処理（リスナーがいる時のみ STT へ流す）。
 * @param {import('socket.io').Server} io
 * @param {import('socket.io').Socket} socket
 * @param {ArrayBuffer|Buffer} chunk
 * @param {(socket:any)=>string} getDisplayName
 */
export async function handleAudioChunk(io, socket, chunk, getDisplayName) {
    if (!isCaptionsRuntimeReady()) return;
    const roomId = socket.data.currentRoom;
    if (!roomId || roomListenerCount(roomId) === 0) {
        // リスナー不在: セッションを止め、送信側にも停止を通知（コスト/帯域節約）
        closeSession(socket.id);
        io.to(socket.id).emit('stt-capture-stop');
        return;
    }
    let buf;
    try {
        buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    } catch (_) {
        return;
    }
    if (!buf || buf.length === 0 || buf.length > MAX_CHUNK_BYTES) return;
    const entry = await ensureSession(io, socket, getDisplayName);
    if (entry.session) entry.session.write(buf);
}

/**
 * 話者の STT セッションを終了（マイク OFF / 切断 / ワールド変更時）。
 * @param {string} socketId
 */
export function closeSession(socketId) {
    const entry = sessions.get(socketId);
    if (!entry) return;
    try { if (entry.session) entry.session.close(); } catch (_) { /* ignore */ }
    sessions.delete(socketId);
}

/**
 * ソケット切断/ワールド変更時の全クリーンアップ（リスナー解除＋セッション終了）。
 * @param {import('socket.io').Server} io
 * @param {import('socket.io').Socket} socket
 */
export function cleanupSocket(io, socket) {
    for (const [rid, set] of listenersByRoom) {
        if (set.has(socket.id)) {
            set.delete(socket.id);
            if (set.size === 0) {
                listenersByRoom.delete(rid);
                io.to(rid).emit('stt-capture-stop');
            }
        }
    }
    closeSession(socket.id);
}
