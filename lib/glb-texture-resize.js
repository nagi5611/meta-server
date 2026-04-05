// lib/glb-texture-resize.js — GLB 内テクスチャの長辺上限リサイズ（アップロードパイプライン用）
import { NodeIO } from '@gltf-transform/core';
import { KHRONOS_EXTENSIONS, EXTTextureWebP, EXTTextureAVIF } from '@gltf-transform/extensions';
import { textureCompress } from '@gltf-transform/functions';
import sharp from 'sharp';
import draco3d from 'draco3dgltf';

/** 長辺の上限（px）。textureCompress の resize は縦横上限かつ縦横比維持。 */
export const GLB_TEXTURE_MAX_EDGE_PX = 1536;

/** リサイズ処理のタイムアウト（ms）。アップロード受信時間は含まない。 */
export const GLB_TEXTURE_RESIZE_TIMEOUT_MS = 30_000;

/** multer と揃えた GLB 最大バイト数 */
export const GLB_UPLOAD_MAX_BYTES = 200 * 1024 * 1024;

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

/** 空間チャンク分割の書き出し処理実行中（リサイズ完了後） */
let processingSpatialChunk = false;

/**
 * @param {boolean} active
 */
export function setGlbSpatialChunkProcessing(active) {
    processingSpatialChunk = !!active;
}

/**
 * 管理画面用: サーバ側 GLB 処理キューの概況
 * @returns {{ waiting: number, processing: boolean, spatialChunking: boolean }}
 */
export function getModelUploadQueueStats() {
    const processing = processingGlb;
    const waiting = Math.max(0, pipelineDepth - (processing ? 1 : 0));
    return { waiting, processing, spatialChunking: processingSpatialChunk };
}

/**
 * GLB バイナリを直列キューに載せてリサイズする。失敗時は呼び出し側が元バッファを保存する。
 * @param {Buffer} originalBuffer
 * @returns {Promise<{ buffer: Buffer, textureResize: object }>}
 */
export function runGlbTextureResizeQueued(originalBuffer) {
    pipelineDepth++;
    const safeOriginal = Buffer.isBuffer(originalBuffer)
        ? originalBuffer
        : Buffer.from(originalBuffer ?? []);

    const run = queueTail.then(async () => {
        processingGlb = true;
        try {
            const textureResize = await resizeGlbTexturesInternal(safeOriginal);
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
 * @returns {Promise<object>}
 */
async function resizeGlbTexturesInternal(originalBuffer) {
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

        const resizePromise = (async () => {
            await doc.transform(
                textureCompress({
                    encoder: sharp,
                    resize: [GLB_TEXTURE_MAX_EDGE_PX, GLB_TEXTURE_MAX_EDGE_PX],
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
            message: `テクスチャの長辺を最大 ${GLB_TEXTURE_MAX_EDGE_PX}px に縮小して保存しました。`,
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
