// lib/s3-model-assets.js — モデルファイルの S3 アップロード・起動時同期・公開 CDN URL 構築
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { S3Client, PutObjectCommand, HeadObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import {
    AWS_REGION,
    S3_BUCKET,
    normalizedS3KeyPrefix,
    normalizedCdnBaseUrl,
    isS3ModelsConfigComplete,
} from '../config/s3-assets.js';

/** @type {import('@aws-sdk/client-s3').S3Client | null} */
let s3Singleton = null;

/**
 * @returns {import('@aws-sdk/client-s3').S3Client}
 */
export function getS3Client() {
    if (!s3Singleton) {
        if (!AWS_REGION || !S3_BUCKET) {
            throw new Error('[s3-model-assets] AWS_REGION / META_MODELS_S3_BUCKET required');
        }
        s3Singleton = new S3Client({ region: AWS_REGION });
    }
    return s3Singleton;
}

/**
 * MODELS_DIR 相対 posix パスから S3 キーへ
 * @param {string} relativePosix models 直下の相対（例 Foo/bar.glb）
 * @returns {string}
 */
export function s3KeyForModelsRelative(relativePosix) {
    const pref = normalizedS3KeyPrefix();
    const rel = String(relativePosix || '').replace(/^\/+/, '').replace(/\\/g, '/');
    return pref ? `${pref}/${rel}` : rel;
}

/**
 * ローカル models 直下のファイルを S3 に Put する（同期成功後など）
 * @param {string} localAbsPath
 * @param {string} modelsDirAbs
 * @param {string} [contentTypeHint]
 * @returns {Promise<string>} S3 オブジェクトキー
 */
export async function uploadLocalModelsFile(localAbsPath, modelsDirAbs, contentTypeHint) {
    if (!isS3ModelsConfigComplete()) {
        throw new Error('[s3-model-assets] S3 models mode not configured');
    }
    const rel = path.relative(modelsDirAbs, localAbsPath);
    if (rel.includes('..') || rel.startsWith('..')) {
        throw new Error('[s3-model-assets] path escapes models dir');
    }
    const key = s3KeyForModelsRelative(rel.split(path.sep).join('/'));
    const buf = await fs.promises.readFile(localAbsPath);
    const ct = contentTypeHint || guessContentType(localAbsPath);
    const cli = getS3Client();
    await cli.send(
        new PutObjectCommand({
            Bucket: S3_BUCKET,
            Key: key,
            Body: buf,
            ContentType: ct,
        })
    );
    return key;
}

/**
 * S3 キーを順に削除（ロールバック用・ベストエフォート）
 * @param {string[]} keys
 * @returns {Promise<void>}
 */
export async function deleteS3ObjectsByKeys(keys) {
    if (!isS3ModelsConfigComplete() || keys.length === 0) return;
    const cli = getS3Client();
    await Promise.all(
        keys.map((key) =>
            cli.send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: key })).catch(() => {})
        )
    );
}

/**
 * ローカルの絶対パス群を S3 に送る。途中失敗時は送信済みキーを削除する
 * @param {string[]} localAbsPaths
 * @param {string} modelsDirAbs
 */
export async function uploadLocalModelsPathsOrRollbackS3(localAbsPaths, modelsDirAbs) {
    /** @type {string[]} */
    const uploaded = [];
    try {
        for (const abs of localAbsPaths) {
            const k = await uploadLocalModelsFile(abs, modelsDirAbs);
            uploaded.push(k);
        }
    } catch (e) {
        await deleteS3ObjectsByKeys(uploaded);
        throw e;
    }
}

/**
 * @param {string} filepath
 * @returns {string}
 */
function guessContentType(filepath) {
    const lower = filepath.toLowerCase();
    if (lower.endsWith('.glb')) return 'model/gltf-binary';
    if (lower.endsWith('.gltf')) return 'model/gltf+json';
    if (lower.endsWith('.json')) return 'application/json';
    if (lower.endsWith('.png')) return 'image/png';
    if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
    return 'application/octet-stream';
}

/**
 * models ディレクトリからの posix 相対パスに対応する CDN 上の公開 URL（署名なし、永続データ用）
 * @param {string} modelsRelativePosix models からの相対（posix）
 * @returns {string}
 */
export function canonicalCdnUrlForModelsRelative(modelsRelativePosix) {
    const base = normalizedCdnBaseUrl();
    const pathname = '/' + modelsRelativePosix.replace(/^\/+/, '').replace(/\\/g, '/').split('/').map(encodeURIComponent).join('/');
    return base + pathname;
}

/**
 * ローカルの models 直下の相対 posix -> CDN URL（公開オブジェクトへの論理リンク。GET は署名必須想定）
 * @param {string} modelsRelativePosix
 * @returns {string}
 */
export function publicAssetUrlCacheForModels(modelsRelativePosix) {
    return canonicalCdnUrlForModelsRelative(modelsRelativePosix);
}

/**
 * アップロード失敗などで書き込んだローカルファイルを消す（ベストエフォート）
 * @param {string} absPath
 */
export function tryUnlinkQuiet(absPath) {
    try {
        if (absPath && fs.existsSync(absPath)) {
            fs.unlinkSync(absPath);
        }
    } catch {
        /* ignore */
    }
}

/**
 * ディレクトリを再帰削除（Prefab などのロールバック）
 * @param {string} absDir
 */
export function tryRmDirQuiet(absDir) {
    try {
        if (absDir && fs.existsSync(absDir)) {
            fs.rmSync(absDir, { recursive: true, force: true });
        }
    } catch {
        /* ignore */
    }
}

/**
 * S3 上のオブジェクトの ETag（アップロード時のシングルパートは MD5 寄り）。なければ null
 * @param {string} key
 * @returns {Promise<string|null>}
 */
async function headEtag(key) {
    try {
        const cli = getS3Client();
        const head = await cli.send(
            new HeadObjectCommand({
                Bucket: S3_BUCKET,
                Key: key,
            })
        );
        const e = head.ETag;
        return typeof e === 'string' ? e.replace(/"/g, '') : null;
    } catch {
        return null;
    }
}

/**
 * ローカルファイルの MD5 hex（ETag 比較用・小ファイル向け）
 * @param {string} absPath
 * @returns {Promise<string>}
 */
async function md5FileHex(absPath) {
    const buf = await fs.promises.readFile(absPath);
    return crypto.createHash('md5').update(buf).digest('hex');
}

/**
 * 起動時: ローカル models をマスターに S3 を突き合わせ、欠けまたは ETag 不一致ならアップロードする
 * @param {string} modelsDirAbs
 * @param {{ onLog?: (msg: string) => void }} [opts]
 * @returns {Promise<{ uploaded: number, skipped: number, errors: number }>}
 */
export async function syncLocalModelsToS3OnStartup(modelsDirAbs, opts = {}) {
    const log = opts.onLog || ((m) => console.log(`[s3-sync] ${m}`));
    if (!isS3ModelsConfigComplete() || !fs.existsSync(modelsDirAbs)) {
        return { uploaded: 0, skipped: 0, errors: 0 };
    }
    let uploaded = 0;
    let skipped = 0;
    let errors = 0;

    /** @type {string[]} */
    const stack = [''];
    while (stack.length) {
        const rel = stack.pop();
        const absDir = rel ? path.join(modelsDirAbs, rel) : modelsDirAbs;
        let entries;
        try {
            entries = fs.readdirSync(absDir, { withFileTypes: true });
        } catch {
            continue;
        }
        for (const ent of entries) {
            const subRel = rel ? `${rel}/${ent.name}` : ent.name;
            if (ent.isDirectory()) {
                stack.push(subRel.split(path.sep).join('/'));
                continue;
            }
            if (!ent.isFile()) continue;
            const absFile = path.join(absDir, ent.name);
            const posixRel = subRel.split(path.sep).join('/');
            const key = s3KeyForModelsRelative(posixRel);
            try {
                const localMd5 = await md5FileHex(absFile);
                const remote = await headEtag(key);
                if (remote && !remote.includes('-') && remote.length === 32 && remote === localMd5) {
                    skipped++;
                    continue;
                }
                await uploadLocalModelsFile(absFile, modelsDirAbs);
                uploaded++;
                log(`uploaded (sync) ${key}`);
            } catch (e) {
                errors++;
                console.error(`[s3-sync] failed ${key}:`, e);
            }
        }
    }
    return { uploaded, skipped, errors };
}

/**
 * S3 にのみ存在しローカルに無いオブジェクトを取り込む（既定では簡略化のため未実装フラグ）。将来用。
 */
