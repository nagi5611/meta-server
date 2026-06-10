// lib/glb-texture-resize.js — GLB 内テクスチャの長辺上限リサイズ（アップロードパイプライン用）
import { NodeIO } from '@gltf-transform/core';
import { KHRONOS_EXTENSIONS, EXTTextureWebP, EXTTextureAVIF } from '@gltf-transform/extensions';
import { textureCompress } from '@gltf-transform/functions';
import sharp from 'sharp';
import draco3d from 'draco3dgltf';
import { MODEL_UPLOAD_MAX_BYTES } from './model-upload-max-bytes.js';
import { computeBoundsFromDocument } from './glb-bounds.js';

/** 未指定時の長辺上限（px）。textureCompress の resize は縦横上限かつ縦横比維持。 */
export const GLB_TEXTURE_MAX_EDGE_PX = 1536;

/** アップロードで指定可能な長辺の最小・最大（px）。 */
export const GLB_TEXTURE_EDGE_MIN_PX = 64;
export const GLB_TEXTURE_EDGE_MAX_PX_ALLOWED = 8192;

/**
 * 管理画面アップロードの textureMaxEdge を解釈する。空・未送信なら既定の長辺上限を返す。
 * @param {unknown} raw FormData 等の値
 * @returns {{ ok: true, value: number } | { ok: false, error: string }}
 */
export function parseTextureMaxEdgeFromUploadBody(raw) {
    if (raw === undefined || raw === null) {
        return { ok: true, value: GLB_TEXTURE_MAX_EDGE_PX };
    }
    const s = String(raw).trim();
    if (s === '') {
        return { ok: true, value: GLB_TEXTURE_MAX_EDGE_PX };
    }
    if (!/^\d+$/.test(s)) {
        return {
            ok: false,
            error: `textureMaxEdge は ${GLB_TEXTURE_EDGE_MIN_PX}〜${GLB_TEXTURE_EDGE_MAX_PX_ALLOWED} の整数で指定してください。`,
        };
    }
    const n = parseInt(s, 10);
    if (!Number.isFinite(n)) {
        return {
            ok: false,
            error: `textureMaxEdge は ${GLB_TEXTURE_EDGE_MIN_PX}〜${GLB_TEXTURE_EDGE_MAX_PX_ALLOWED} の整数で指定してください。`,
        };
    }
    if (n < GLB_TEXTURE_EDGE_MIN_PX || n > GLB_TEXTURE_EDGE_MAX_PX_ALLOWED) {
        return {
            ok: false,
            error: `textureMaxEdge は ${GLB_TEXTURE_EDGE_MIN_PX}〜${GLB_TEXTURE_EDGE_MAX_PX_ALLOWED} の整数で指定してください。`,
        };
    }
    return { ok: true, value: n };
}

/**
 * @param {number} n
 * @returns {number}
 */
function clampTextureMaxEdgePx(n) {
    const r = Math.round(Number(n));
    if (!Number.isFinite(r)) return GLB_TEXTURE_MAX_EDGE_PX;
    return Math.min(GLB_TEXTURE_EDGE_MAX_PX_ALLOWED, Math.max(GLB_TEXTURE_EDGE_MIN_PX, r));
}

/** リサイズ処理のタイムアウト（ms）。アップロード受信時間は含まない。 */
export const GLB_TEXTURE_RESIZE_TIMEOUT_MS = 30_000;

/** multer（MODEL_UPLOAD_MAX_MB）と揃えた GLB 最大バイト数 */
export const GLB_UPLOAD_MAX_BYTES = MODEL_UPLOAD_MAX_BYTES;

const extensions = [...KHRONOS_EXTENSIONS, EXTTextureWebP, EXTTextureAVIF];

let ioInitPromise = null;

/**
 * Draco 付き GLB を扱う NodeIO を遅延初期化する。
 * @returns {Promise<import('@gltf-transform/core').NodeIO>}
 */
function getNodeIo() {
    if (!ioInitPromise) {
        ioInitPromise = (async () => {
            const decoder = await draco3d.createDecoderModule();
            const encoder = await draco3d.createEncoderModule();
            return new NodeIO()
                .registerExtensions(extensions)
                .registerDependencies({
                    'draco3d.decoder': decoder,
                    'draco3d.encoder': encoder,
                });
        })();
    }
    return ioInitPromise;
}

/**
 * glTF 読み書き用 NodeIO（テクスチャ縮小・チャンク分割などで共有）
 * @returns {Promise<import('@gltf-transform/core').NodeIO>}
 */
export function getGltfTransformIO() {
    return getNodeIo();
}

let queueTail = Promise.resolve();

/** パイプラインに載っているジョブ数（実行中を含む） */
let pipelineDepth = 0;

/** リサイズ処理実行中 */
let processingGlb = false;

/**
 * 管理画面用: サーバ側 GLB 処理キューの概況
 * @returns {{ waiting: number, processing: boolean }}
 */
export function getModelUploadQueueStats() {
    const processing = processingGlb;
    const waiting = Math.max(0, pipelineDepth - (processing ? 1 : 0));
    return { waiting, processing };
}

/**
 * GLB バイナリを直列キューに載せてリサイズする。失敗時は呼び出し側が元バッファを保存する。
 * @param {Buffer} originalBuffer
 * @param {{ maxEdgePx?: number }} [options]
 * @returns {Promise<{ buffer: Buffer, textureResize: object }>}
 */
/**
 * プレハブ ZIP 用: readBinary → bounds 算出 → 任意でテクスチャ縮小 → writeBinary（同一 doc、方針 A）
 * @param {Buffer} originalBuffer
 * @param {{ maxEdgePx?: number, skipTextureResize?: boolean }} [options]
 * @returns {Promise<{ buffer: Buffer, bounds: import('./glb-bounds.js').GlbBounds | null, textureResize: object }>}
 */
export function runGlbPrefabProcessQueued(originalBuffer, options = {}) {
    pipelineDepth++;
    const safeOriginal = Buffer.isBuffer(originalBuffer)
        ? originalBuffer
        : Buffer.from(originalBuffer ?? []);

    const run = queueTail.then(async () => {
        processingGlb = true;
        try {
            return await processGlbForPrefabUploadInternal(safeOriginal, options);
        } catch (err) {
            console.error('GLB prefab process queue job error:', err);
            return {
                buffer: safeOriginal,
                bounds: null,
                textureResize: {
                    attempted: true,
                    applied: false,
                    error: 'GLB 処理でエラーが発生したため、元ファイルを保存しました。',
                    errorDetail: err instanceof Error ? `${err.message}\n${err.stack || ''}`.trim() : String(err),
                },
            };
        } finally {
            processingGlb = false;
            pipelineDepth--;
        }
    });
    queueTail = run.catch((e) => {
        console.error('GLB upload queue chain error:', e);
        return Promise.resolve();
    });
    return run;
}

/**
 * @param {Buffer} originalBuffer
 * @param {{ maxEdgePx?: number, skipTextureResize?: boolean }} [options]
 * @returns {Promise<{ buffer: Buffer, bounds: import('./glb-bounds.js').GlbBounds | null, textureResize: object }>}
 */
async function processGlbForPrefabUploadInternal(originalBuffer, options = {}) {
    const skipTextureResize = options.skipTextureResize === true;
    const maxEdgePx = clampTextureMaxEdgePx(options.maxEdgePx ?? GLB_TEXTURE_MAX_EDGE_PX);

    const io = await getNodeIo();
    const view = new Uint8Array(originalBuffer.buffer, originalBuffer.byteOffset, originalBuffer.byteLength);
    const doc = await io.readBinary(view);
    const bounds = computeBoundsFromDocument(doc);

    if (skipTextureResize) {
        return {
            buffer: originalBuffer,
            bounds,
            textureResize: { attempted: false, applied: false },
        };
    }

    const textureResize = await resizeGlbTexturesFromDocument(doc, maxEdgePx, io);
    const buffer =
        textureResize.applied &&
        Buffer.isBuffer(textureResize.buffer) &&
        textureResize.buffer.length > 0
            ? textureResize.buffer
            : originalBuffer;
    const { buffer: _b, ...rest } = textureResize;
    return { buffer, bounds, textureResize: rest };
}

/**
 * @param {import('@gltf-transform/core').Document} doc
 * @param {number} maxEdgePx
 * @param {import('@gltf-transform/core').NodeIO} io
 * @returns {Promise<object>}
 */
async function resizeGlbTexturesFromDocument(doc, maxEdgePx, io) {
    const base = {
        attempted: true,
        applied: false,
        message: undefined,
        error: undefined,
        errorDetail: undefined,
        buffer: undefined,
    };

    const fail = (error, errorDetail) => ({
        ...base,
        error: error || 'テクスチャの縮小に失敗しました。',
        errorDetail: errorDetail || '',
    });

    try {
        const edge = clampTextureMaxEdgePx(maxEdgePx);
        const resizePromise = (async () => {
            await doc.transform(
                textureCompress({
                    encoder: sharp,
                    resize: [edge, edge],
                })
            );
            const out = await io.writeBinary(doc);
            return Buffer.from(out);
        })();

        const resizedBuffer = await new Promise((resolve, reject) => {
            const t = setTimeout(() => {
                reject(new Error(`GLB テクスチャ縮小が ${GLB_TEXTURE_RESIZE_TIMEOUT_MS}ms を超えました`));
            }, GLB_TEXTURE_RESIZE_TIMEOUT_MS);
            resizePromise
                .then((buf) => {
                    clearTimeout(t);
                    resolve(buf);
                })
                .catch((e) => {
                    clearTimeout(t);
                    reject(e);
                });
        });

        if (resizedBuffer.length > GLB_UPLOAD_MAX_BYTES) {
            return fail(
                '縮小後の GLB がサイズ上限を超えたため、元ファイルを保存しました。',
                `resizedBytes=${resizedBuffer.length} maxBytes=${GLB_UPLOAD_MAX_BYTES}`
            );
        }

        return {
            attempted: true,
            applied: true,
            maxEdgePx: edge,
            message: `テクスチャの長辺を最大 ${edge}px に縮小して保存しました。`,
            error: undefined,
            errorDetail: undefined,
            buffer: resizedBuffer,
        };
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const stack = err instanceof Error && err.stack ? err.stack : '';
        return fail(
            'テクスチャ縮小中にエラーが発生したため、元の GLB をそのまま保存しました。',
            `${msg}\n${stack}`.trim()
        );
    }
}

export function runGlbTextureResizeQueued(originalBuffer, options = {}) {
    pipelineDepth++;
    const safeOriginal = Buffer.isBuffer(originalBuffer)
        ? originalBuffer
        : Buffer.from(originalBuffer ?? []);

    const run = queueTail.then(async () => {
        processingGlb = true;
        try {
            const maxEdgePx = clampTextureMaxEdgePx(options.maxEdgePx ?? GLB_TEXTURE_MAX_EDGE_PX);
            const textureResize = await resizeGlbTexturesInternal(safeOriginal, maxEdgePx);
            const buffer =
                textureResize.applied &&
                Buffer.isBuffer(textureResize.buffer) &&
                textureResize.buffer.length > 0
                    ? textureResize.buffer
                    : safeOriginal;
            const tr =
                textureResize && typeof textureResize === 'object'
                    ? textureResize
                    : { attempted: false, applied: false };
            const { buffer: _b, ...rest } = tr;
            return { buffer, textureResize: rest };
        } catch (err) {
            console.error('GLB texture resize queue job error:', err);
            return {
                buffer: safeOriginal,
                textureResize: {
                    attempted: true,
                    applied: false,
                    error: 'GLB 処理でエラーが発生したため、元ファイルを保存しました。',
                    errorDetail: err instanceof Error ? `${err.message}\n${err.stack || ''}`.trim() : String(err),
                },
            };
        } finally {
            processingGlb = false;
            pipelineDepth--;
        }
    });
    queueTail = run.catch((e) => {
        console.error('GLB upload queue chain error:', e);
        return Promise.resolve();
    });
    return run;
}

/**
 * @param {Buffer} originalBuffer
 * @param {number} maxEdgePx 長辺・短辺それぞれの上限（縦横比維持）
 * @returns {Promise<object>}
 */
async function resizeGlbTexturesInternal(originalBuffer, maxEdgePx) {
    const base = {
        attempted: true,
        applied: false,
        message: undefined,
        error: undefined,
        errorDetail: undefined,
        buffer: undefined,
    };

    const fail = (error, errorDetail) => ({
        ...base,
        error: error || 'テクスチャの縮小に失敗しました。',
        errorDetail: errorDetail || '',
    });

    try {
        const io = await getNodeIo();
        const view = new Uint8Array(originalBuffer.buffer, originalBuffer.byteOffset, originalBuffer.byteLength);
        const doc = await io.readBinary(view);
        return await resizeGlbTexturesFromDocument(doc, maxEdgePx, io);
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const stack = err instanceof Error && err.stack ? err.stack : '';
        return fail(
            'テクスチャ縮小中にエラーが発生したため、元の GLB をそのまま保存しました。',
            `${msg}\n${stack}`.trim()
        );
    }
}
