// lib/captions-server.js — サーバー側の字幕コーディネータ
// - ルームごとの「字幕リスナー」集合を管理し、0->1 / 1->0 で話者へ capture 開始/停止を指示（コスト最適化）
// - 話者ごとの STT セッションを遅延生成し、interim/final を配信、final を DB 保存
// - final 時は Google Translation API で聞き手の uiLocale へ翻訳し per-socket 配信
import {
    isCaptionsRuntimeReady,
    isCaptionTranslationReady,
    getCaptionInterimThrottleMs,
} from './captions-config.js';
import { CaptionSegmenter } from './caption-segmenter.js';
import { createCaptionSession } from './speech-captions.js';
import { translateCaptionText } from './caption-translation.js';
import { getCaptionListenerTargetLocales, normalizeUiLocale } from './ui-locale.js';
import { insertCaptionLog } from '../db/captions-log.js';

/** roomId -> Set<socketId>（字幕を見たい聞き手） */
const listenersByRoom = new Map();
/** socketId -> { session, roomId, username, lastInterimAt, segmenter } */
const sessions = new Map();

/** @type {((roomId: string) => { players: Map<string, { uiLocale?: string }> } | null | undefined) | null} */
let getRoomStateFn = null;

/** 1 チャンクの最大バイト数（濫用防止）。16k mono 16bit なら 100ms=3200B、余裕を見て 64KB。 */
const MAX_CHUNK_BYTES = 64 * 1024;

/**
 * ルーム状態取得関数を注入する（server.js の getRoomState）
 * @param {{ getRoomState: (roomId: string) => { players: Map<string, { uiLocale?: string }> } | null | undefined }} deps
 */
export function configureCaptionsServer(deps) {
    getRoomStateFn = deps?.getRoomState || null;
}

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
 * @param {{ username: string }} entry
 * @param {string} roomId
 * @param {{ text: string, isFinal: boolean, utteranceId: number, utteranceEnd?: boolean }} ev
 */
function emitCaptionEvent(io, socket, entry, roomId, ev) {
    const rid = socket.data.currentRoom || roomId;
    const payload = {
        peerId: socket.id,
        username: entry.username,
        text: ev.text,
        isFinal: ev.isFinal,
        utteranceId: ev.utteranceId,
        utteranceEnd: !!ev.utteranceEnd,
    };
    io.to(rid).emit('stt-caption', payload);

    if (ev.isFinal && ev.text && isCaptionTranslationReady()) {
        void emitFinalTranslations(io, socket, entry, rid, ev).catch((err) => {
            console.error('[captions-tr] emitFinalTranslations failed:', err?.message || err);
        });
    }
}

/**
 * final 確定後に翻訳を非同期生成し、対象聞き手へ個別配信する
 * @param {import('socket.io').Server} io
 * @param {import('socket.io').Socket} socket
 * @param {{ username: string }} entry
 * @param {string} roomId
 * @param {{ text: string, utteranceId: number }} ev
 */
async function emitFinalTranslations(io, socket, entry, roomId, ev) {
    if (!getRoomStateFn) return;

    const listenerIds = listenersByRoom.get(roomId);
    if (!listenerIds || listenerIds.size === 0) return;

    const roomState = getRoomStateFn(roomId);
    if (!roomState?.players) return;

    const speakerLocale = normalizeUiLocale(socket.data?.uiLocale);
    const targetLocales = getCaptionListenerTargetLocales(
        roomState,
        listenerIds,
        socket.id,
        speakerLocale,
    );
    if (targetLocales.length === 0) return;

    const translationResults = await Promise.all(
        targetLocales.map(async (locale) => {
            const result = await translateCaptionText({
                text: ev.text,
                sourceLocale: speakerLocale,
                targetLocale: locale,
            });
            return { locale, ...result };
        }),
    );

    /** @type {Partial<Record<import('./ui-locale.js').UiLocale, string>>} */
    const translationsByLocale = {};
    for (const { locale, translated, skipped } of translationResults) {
        if (
            !skipped &&
            typeof translated === 'string' &&
            translated.trim() &&
            translated !== ev.text
        ) {
            translationsByLocale[locale] = translated.trim();
        }
    }
    if (Object.keys(translationsByLocale).length === 0) return;

    const basePayload = {
        peerId: socket.id,
        username: entry.username,
        text: ev.text,
        isFinal: true,
        utteranceId: ev.utteranceId,
        utteranceEnd: false,
    };

    for (const listenerId of listenerIds) {
        if (listenerId === socket.id) continue;
        const player = roomState.players.get(listenerId);
        if (!player) continue;
        const listenerLocale = normalizeUiLocale(player.uiLocale);
        const translatedMessage = translationsByLocale[listenerLocale];
        if (!translatedMessage) continue;
        const targetSocket = io.sockets.sockets.get(listenerId);
        if (!targetSocket) continue;
        targetSocket.emit('stt-caption', {
            ...basePayload,
            translatedMessage,
        });
    }
}

/**
 * @param {import('socket.io').Server} io
 * @param {import('socket.io').Socket} socket
 * @param {(socket:any)=>string} getDisplayName
 */
async function ensureSession(io, socket, getDisplayName) {
    const existing = sessions.get(socket.id);
    if (existing?.session) return existing;

    const roomId = socket.data.currentRoom;
    const username = getDisplayName(socket);
    const entry = existing || {
        session: null,
        roomId,
        username,
        lastInterimAt: 0,
        segmenter: new CaptionSegmenter(),
    };
    if (!entry.segmenter) entry.segmenter = new CaptionSegmenter();
    sessions.set(socket.id, entry);

    const throttleMs = getCaptionInterimThrottleMs();
    const emitSegmented = (text, isFinal) => {
        const events = entry.segmenter.process(text, isFinal);
        for (const ev of events) {
            emitCaptionEvent(io, socket, entry, roomId, ev);
        }
        return events;
    };

    const session = await createCaptionSession({
        onInterim: (text) => {
            const now = Date.now();
            if (now - entry.lastInterimAt < throttleMs) return;
            entry.lastInterimAt = now;
            emitSegmented(text, false);
        },
        onFinal: (text) => {
            entry.lastInterimAt = 0;
            const events = emitSegmented(text, true);
            const finalEvent = events.find((ev) => ev.isFinal && ev.text);
            if (!finalEvent) return;
            try {
                insertCaptionLog({
                    roomId: socket.data.currentRoom || roomId,
                    peerId: socket.id,
                    username: entry.username,
                    transcript: finalEvent.text,
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
 * @param {import('socket.io').Server} io
 * @param {import('socket.io').Socket} socket
 * @param {ArrayBuffer|Buffer} chunk
 * @param {(socket:any)=>string} getDisplayName
 */
export async function handleAudioChunk(io, socket, chunk, getDisplayName) {
    if (!isCaptionsRuntimeReady()) return;
    const roomId = socket.data.currentRoom;
    if (!roomId || roomListenerCount(roomId) === 0) {
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
 * @param {string} socketId
 */
export function closeSession(socketId) {
    const entry = sessions.get(socketId);
    if (!entry) return;
    try { if (entry.session) entry.session.close(); } catch (_) { /* ignore */ }
    sessions.delete(socketId);
}

/**
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
