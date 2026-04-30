// lib/s3-env-assets.js — IBL 用 HDR の S3 アップロード・起動時同期・CDN URL（アバターと同様に models プレフィックスの兄弟パス）
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import {
    S3_BUCKET,
    normalizedCdnBaseUrl,
    normalizedS3KeyPrefix,
    normalizedEnvS3KeyPrefix,
    isS3ModelsBucketConfigured,
} from '../config/s3-assets.js';
import { getS3Client, MANIFEST_CACHE_CONTROL } from './s3-model-assets.js';

/**
 * env ディレクトリからの相対 posix → S3 キー（META_ENV_S3_PREFIX 配下）
 * @param {string} relativePosix
 * @returns {string}
 */
export function s3KeyForEnvRelative(relativePosix) {
    const pref = normalizedEnvS3KeyPrefix();
    const rel = String(relativePosix || '').replace(/^\/+/, '').replace(/\\/g, '/');
    return pref ? `${pref}/${rel}` : rel;
}

/**
 * META_CDN_PUBLIC_BASE が .../models で終わる場合、兄弟フォルダ .../env を指す CDN URL を組む
 * @param {string} relUnderEnvPrefix env プレフィックス直下の相対（例 default.hdr）
 * @returns {string}
 */
export function canonicalCdnUrlForEnvRelative(relUnderEnvPrefix) {
    const base = normalizedCdnBaseUrl();
    const modelsEncodedTail =
        '/' +
        normalizedS3KeyPrefix()
            .split('/')
            .filter(Boolean)
            .map((s) => encodeURIComponent(s))
            .join('/');
    let rootBase = base;
    if (modelsEncodedTail.length > 1 && base.endsWith(modelsEncodedTail)) {
        rootBase = base.slice(0, -modelsEncodedTail.length);
    }
    const envPrefParts = normalizedEnvS3KeyPrefix()
        .split('/')
        .filter(Boolean)
        .map((s) => encodeURIComponent(s));
    const restParts = String(relUnderEnvPrefix || '')
        .replace(/^\/+/, '')
        .split('/')
        .filter(Boolean)
        .map((s) => encodeURIComponent(s));
    const pathname = '/' + [...envPrefParts, ...restParts].join('/');
    return rootBase + pathname;
}

/**
 * @param {string} filepath
 * @returns {string}
 */
function guessContentTypeEnv(filepath) {
    const lower = filepath.toLowerCase();
    if (lower.endsWith('.hdr')) return 'application/octet-stream';
    return 'application/octet-stream';
}

/**
 * @param {string} key
 * @returns {Promise<string|null>}
 */
async function headEtagEnv(key) {
    if (!isS3ModelsBucketConfigured()) return null;
    try {
        const head = await getS3Client().send(
            new HeadObjectCommand({
                Bucket: S3_BUCKET,
                Key: key,
            }),
        );
        const e = head.ETag;
        return typeof e === 'string' ? e.replace(/"/g, '') : null;
    } catch {
        return null;
    }
}

/**
 * @param {string} absPath
 * @returns {Promise<string>}
 */
async function md5FileHex(absPath) {
    const buf = await fs.promises.readFile(absPath);
    return crypto.createHash('md5').update(buf).digest('hex');
}

/**
 * ローカル ENV_DIR 直下の HDR を S3 に Put する（同一ファイル名で差し替え可能なため Cache-Control は短期）
 * @param {string} localAbsPath
 * @param {string} envDirAbs
 * @param {string} [cacheControlHint]
 * @returns {Promise<string>} S3 オブジェクトキー
 */
export async function uploadLocalEnvFile(localAbsPath, envDirAbs, cacheControlHint) {
    if (!isS3ModelsBucketConfigured()) {
        throw new Error('[s3-env-assets] S3 bucket not configured (USE_S3_MODELS, AWS_REGION, META_MODELS_S3_BUCKET)');
    }
    const rel = path.relative(envDirAbs, localAbsPath);
    if (rel.includes('..') || rel.startsWith('..')) {
        throw new Error('[s3-env-assets] path escapes env dir');
    }
    const posixRel = rel.split(path.sep).join('/');
    const key = s3KeyForEnvRelative(posixRel);
    const buf = await fs.promises.readFile(localAbsPath);
    const ct = guessContentTypeEnv(localAbsPath);
    const cacheCtl = cacheControlHint ?? MANIFEST_CACHE_CONTROL;
    await getS3Client().send(
        new PutObjectCommand({
            Bucket: S3_BUCKET,
            Key: key,
            Body: buf,
            ContentType: ct,
            CacheControl: cacheCtl,
        }),
    );
    return key;
}

/**
 * env 配下の .hdr ファイル一覧（起動時同期用）
 * @param {string} envDirAbs
 * @returns {Record<string, { mtimeMs: number, name: string }>}
 */
export function collectLocalEnvDiskStateForSync(envDirAbs) {
    /** @type {Record<string, { mtimeMs: number, name: string }>} */
    const out = {};
    /** @type {string[]} */
    const stack = [''];
    while (stack.length) {
        const rel = stack.pop();
        const absDir = rel ? path.join(envDirAbs, rel) : envDirAbs;
        let entries;
        try {
            entries = fs.readdirSync(absDir, { withFileTypes: true });
        } catch {
            continue;
        }
        for (const ent of entries) {
            const subRel = rel ? `${rel}/${ent.name}` : ent.name;
            const subPosix = subRel.split(path.sep).join('/');
            if (ent.isDirectory()) {
                stack.push(subRel);
                continue;
            }
            if (!ent.isFile()) continue;
            if (!ent.name.toLowerCase().endsWith('.hdr')) continue;
            const absFile = path.join(absDir, ent.name);
            try {
                const st = fs.statSync(absFile);
                out[subPosix] = { mtimeMs: Math.trunc(st.mtimeMs), name: ent.name };
            } catch {
                /* skip */
            }
        }
    }
    return out;
}

/**
 * 起動時: ローカル env と S3 の差分を MD5 / ETag で突き合わせてアップロード
 * @param {string} envDirAbs
 * @param {{ onLog?: (msg: string) => void }} [opts]
 * @returns {Promise<{ uploaded: number, skipped: number, errors: number, mode: 'legacy' | 'noop' }>}
 */
export async function syncLocalEnvToS3OnStartup(envDirAbs, opts = {}) {
    const log = opts.onLog || ((m) => console.log(`[s3-env-sync] ${m}`));
    if (!isS3ModelsBucketConfigured() || !fs.existsSync(envDirAbs)) {
        return { uploaded: 0, skipped: 0, errors: 0, mode: 'noop' };
    }

    const disk = collectLocalEnvDiskStateForSync(envDirAbs);
    if (Object.keys(disk).length === 0) {
        return { uploaded: 0, skipped: 0, errors: 0, mode: 'noop' };
    }

    let uploaded = 0;
    let skipped = 0;
    let errors = 0;

    for (const posixRel of Object.keys(disk)) {
        const absFile = path.join(envDirAbs, ...posixRel.split('/'));
        const key = s3KeyForEnvRelative(posixRel);
        try {
            const localMd5 = await md5FileHex(absFile);
            const remote = await headEtagEnv(key);
            if (remote && !remote.includes('-') && remote.length === 32 && remote === localMd5) {
                skipped++;
                continue;
            }
            await uploadLocalEnvFile(absFile, envDirAbs);
            uploaded++;
            log(`uploaded ${key}`);
        } catch (e) {
            errors++;
            console.error(`[s3-env-sync] failed ${key}:`, e);
        }
    }

    return { uploaded, skipped, errors, mode: 'legacy' };
}
