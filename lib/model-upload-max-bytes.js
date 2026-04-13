// lib/model-upload-max-bytes.js — 管理画面 3D モデルアップロードの最大バイト（multer と GLB 処理で共有）

const DEFAULT_MB = 500;

/**
 * MODEL_UPLOAD_MAX_MB をバイトに変換する。無効値は既定 500 MiB。
 * @returns {number}
 */
function computeModelUploadMaxBytes() {
    const raw = process.env.MODEL_UPLOAD_MAX_MB;
    if (raw === undefined || raw === null || String(raw).trim() === '') {
        return Math.floor(DEFAULT_MB * 1024 * 1024);
    }
    const mb = parseFloat(String(raw).trim());
    if (!Number.isFinite(mb) || mb <= 0) {
        console.warn(
            `[model-upload] Invalid MODEL_UPLOAD_MAX_MB="${raw}", using default ${DEFAULT_MB} MiB`,
        );
        return Math.floor(DEFAULT_MB * 1024 * 1024);
    }
    const bytes = Math.floor(mb * 1024 * 1024);
    const minBytes = 1024 * 1024;
    if (bytes < minBytes) {
        console.warn('[model-upload] MODEL_UPLOAD_MAX_MB too small, clamping to 1 MiB');
        return minBytes;
    }
    return bytes;
}

/** 3D モデル一式（/admin/upload）の最大受信サイズ */
export const MODEL_UPLOAD_MAX_BYTES = computeModelUploadMaxBytes();
