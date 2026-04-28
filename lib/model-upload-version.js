// lib/model-upload-version.js — S3 モード時のアップロード用バージョン付きファイル名
import crypto from 'node:crypto';

/**
 * アップロード時の一意バージョン断片（ファイル名に埋め込む）
 * @returns {string}
 */
export function createModelVersionToken() {
    const t = Date.now().toString(36);
    const r = crypto.randomBytes(5).toString('hex');
    return `${t}_${r}`;
}

/**
 * 元ファイル名にバージョンを埋め込む（拡張子の直前）。例 foo.glb -> foo_v_abc_xyz.glb
 * @param {string} originalFilename
 * @param {string} versionToken createModelVersionToken()
 * @returns {string}
 */
export function insertVersionBeforeExt(originalFilename, versionToken) {
    const safe = String(originalFilename || 'model').replace(/[/\\]/g, '_').replace(/^\.+/, '') || 'model';
    const lastDot = safe.lastIndexOf('.');
    if (lastDot <= 0) {
        return `${safe}_v_${versionToken}`;
    }
    const base = safe.slice(0, lastDot);
    const ext = safe.slice(lastDot);
    return `${base}_v_${versionToken}${ext}`;
}
