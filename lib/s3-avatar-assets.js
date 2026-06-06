// lib/s3-avatar-assets.js — アバター GLB と active.json の S3 アップロード・CDN URL・起動時同期
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { PutObjectCommand, DeleteObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import {
    S3_BUCKET,
    normalizedCdnBaseUrl,
    normalizedS3KeyPrefix,
    normalizedAvatarsS3KeyPrefix,
    isS3ModelsBucketConfigured,
} from '../config/s3-assets.js';
import {
    getS3Client,
    tryUnlinkQuiet,
    MANIFEST_CACHE_CONTROL,
    DEFAULT_ASSET_CACHE_CONTROL,
} from './s3-model-assets.js';

/** avatars ディレクトリ直下からの相対 POSIX（例 _meta/active.json） */
export const AVATAR_ACTIVE_META_REL_POSIX = '_meta/active.json';

/**
 * avatars ルートからの相対 posix → S3 キー（META_AVATARS_S3_PREFIX 配下）
 * @param {string} relativePosix
 * @returns {string}
 */
export function s3KeyForAvatarRelative(relativePosix) {
    const pref = normalizedAvatarsS3KeyPrefix();
    const rel = String(relativePosix || '').replace(/^\/+/, '').replace(/\\/g, '/');
    return pref ? `${pref}/${rel}` : rel;
}

/**
 * META_CDN_PUBLIC_BASE が .../models で終わる場合、兄弟フォルダ .../avatars を指す CDN URL を組む
 * @param {string} relUnderAvatarPrefix avatars プレフィックス直下の相対（例 avatar_v_x.glb または _meta/active.json）
 * @returns {string}
 */
export function canonicalCdnUrlForAvatarRelative(relUnderAvatarPrefix) {
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
    const avPrefParts = normalizedAvatarsS3KeyPrefix()
        .split('/')
        .filter(Boolean)
        .map((s) => encodeURIComponent(s));
    const restParts = String(relUnderAvatarPrefix || '')
        .replace(/^\/+/, '')
        .split('/')
        .filter(Boolean)
        .map((s) => encodeURIComponent(s));
    const pathname = '/' + [...avPrefParts, ...restParts].join('/');
    return rootBase + pathname;
}

/**
 * @param {string} relPosixUnderAvatarPrefix
 * @returns {string}
 */
export function publicAssetUrlCacheForAvatars(relPosixUnderAvatarPrefix) {
    return canonicalCdnUrlForAvatarRelative(relPosixUnderAvatarPrefix);
}

/**
 * @param {string} filepath
 * @returns {string}
 */
function guessContentTypeAvatar(filepath) {
    const lower = filepath.toLowerCase();
    if (lower.endsWith('.glb')) return 'model/gltf-binary';
    if (lower.endsWith('.json')) return 'application/json; charset=utf-8';
    return 'application/octet-stream';
}

/**
 * @param {string} key
 * @returns {Promise<string|null>}
 */
async function headEtag(key) {
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
 * ローカル avatars 直下のファイルを S3 に Put する
 * @param {string} localAbsPath
 * @param {string} avatarsDirAbs
 * @param {string} [cacheControlHint]
 * @returns {Promise<string>} S3 オブジェクトキー
 */
export async function uploadLocalAvatarFile(localAbsPath, avatarsDirAbs, cacheControlHint) {
    if (!isS3ModelsBucketConfigured()) {
        throw new Error('[s3-avatar-assets] S3 bucket not configured (USE_S3_MODELS, AWS_REGION, META_MODELS_S3_BUCKET)');
    }
    const rel = path.relative(avatarsDirAbs, localAbsPath);
    if (rel.includes('..') || rel.startsWith('..')) {
        throw new Error('[s3-avatar-assets] path escapes avatars dir');
    }
    const posixRel = rel.split(path.sep).join('/');
    const key = s3KeyForAvatarRelative(posixRel);
    const buf = await fs.promises.readFile(localAbsPath);
    const ct = guessContentTypeAvatar(localAbsPath);
    const cacheCtl = cacheControlHint ?? DEFAULT_ASSET_CACHE_CONTROL;
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
 * active.json をローカルに書き、S3 にも Put する（Cache-Control 短期）
 * @param {string} avatarsDirAbs
 * @param {string} filename アクティブな glb（avatars 直下のファイル名のみ想定）
 * @returns {Promise<void>}
 */
export async function setActiveAvatar(avatarsDirAbs, filename) {
    const safeName = path.basename(String(filename || '').replace(/[/\\]/g, ''));
    if (!safeName.toLowerCase().endsWith('.glb')) {
        throw new Error('[s3-avatar-assets] active avatar must be a .glb filename');
    }
    const payload = { v: 1, filename: safeName, updatedAt: new Date().toISOString() };
    const jsonStr = `${JSON.stringify(payload)}\n`;
    const relParts = AVATAR_ACTIVE_META_REL_POSIX.split('/');
    const dirAbs = path.join(avatarsDirAbs, ...relParts.slice(0, -1));
    const fileAbs = path.join(avatarsDirAbs, ...relParts);
    fs.mkdirSync(dirAbs, { recursive: true });
    await fs.promises.writeFile(fileAbs, jsonStr, 'utf8');

    if (!isS3ModelsBucketConfigured()) return;
    await getS3Client().send(
        new PutObjectCommand({
            Bucket: S3_BUCKET,
            Key: s3KeyForAvatarRelative(AVATAR_ACTIVE_META_REL_POSIX),
            Body: Buffer.from(jsonStr, 'utf8'),
            ContentType: 'application/json; charset=utf-8',
            CacheControl: MANIFEST_CACHE_CONTROL,
        }),
    );
}

/**
 * active.json の参照 GLB を未設定にし、S3 にも Put する（レジストリ上のアバターが 0 件のとき等）
 * @param {string} avatarsDirAbs
 * @returns {Promise<void>}
 */
export async function clearActiveAvatarMeta(avatarsDirAbs) {
    const payload = { v: 1, filename: '', updatedAt: new Date().toISOString() };
    const jsonStr = `${JSON.stringify(payload)}\n`;
    const relParts = AVATAR_ACTIVE_META_REL_POSIX.split('/');
    const dirAbs = path.join(avatarsDirAbs, ...relParts.slice(0, -1));
    const fileAbs = path.join(avatarsDirAbs, ...relParts);
    fs.mkdirSync(dirAbs, { recursive: true });
    await fs.promises.writeFile(fileAbs, jsonStr, 'utf8');
    if (!isS3ModelsBucketConfigured()) return;
    await getS3Client().send(
        new PutObjectCommand({
            Bucket: S3_BUCKET,
            Key: s3KeyForAvatarRelative(AVATAR_ACTIVE_META_REL_POSIX),
            Body: Buffer.from(jsonStr, 'utf8'),
            ContentType: 'application/json; charset=utf-8',
            CacheControl: MANIFEST_CACHE_CONTROL,
        }),
    );
}

/**
 * ローカルの active.json を読む
 * @param {string} avatarsDirAbs
 * @returns {{ v?: number, filename?: string, updatedAt?: string } | null}
 */
export function readActiveAvatarMeta(avatarsDirAbs) {
    const abs = path.join(avatarsDirAbs, ...AVATAR_ACTIVE_META_REL_POSIX.split('/'));
    try {
        if (!fs.existsSync(abs)) return null;
        const raw = fs.readFileSync(abs, 'utf8');
        const j = JSON.parse(raw);
        return j && typeof j === 'object' ? j : null;
    } catch {
        return null;
    }
}

/**
 * クライアントが resolveModelAssetHref に渡すパス（META_AVATARS_S3_PREFIX/filename.glb）
 * @param {string} avatarsDirAbs
 * @returns {string | null}
 */
export function getActiveAvatarRelativePathForClient(avatarsDirAbs) {
    const meta = readActiveAvatarMeta(avatarsDirAbs);
    const fn = meta && typeof meta.filename === 'string' ? meta.filename.trim() : '';
    if (!fn || fn.includes('/') || fn.includes('..')) return null;
    const pref = normalizedAvatarsS3KeyPrefix();
    if (pref) return `${pref}/${fn}`;
    return `avatars/${fn}`;
}

/**
 * ローカルファイルと S3 オブジェクトを削除
 * @param {string} relativePosix avatars からの相対（posix）
 * @param {string} avatarsDirAbs
 * @returns {Promise<void>}
 */
export async function deleteAvatarFile(relativePosix, avatarsDirAbs) {
    const rel = String(relativePosix || '').replace(/^\/+/, '').replace(/\\/g, '/');
    if (!rel || rel.includes('..')) return;
    const abs = path.join(avatarsDirAbs, ...rel.split('/'));
    tryUnlinkQuiet(abs);
    if (!isS3ModelsBucketConfigured()) return;
    try {
        await getS3Client().send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: s3KeyForAvatarRelative(rel) }));
    } catch {
        /* ignore */
    }
}

/**
 * avatars 配下の全ファイルの同期状態（起動時同期用）
 * @param {string} avatarsDirAbs
 * @returns {Record<string, { mtimeMs: number, name: string }>}
 */
export function collectLocalAvatarDiskStateForSync(avatarsDirAbs) {
    /** @type {Record<string, { mtimeMs: number, name: string }>} */
    const out = {};
    /** @type {string[]} */
    const stack = [''];
    while (stack.length) {
        const rel = stack.pop();
        const absDir = rel ? path.join(avatarsDirAbs, rel) : avatarsDirAbs;
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
 * 起動時: ローカル avatars と S3 の差分を MD5 / ETag で突き合わせてアップロード
 * @param {string} avatarsDirAbs
 * @param {{ onLog?: (msg: string) => void }} [opts]
 * @returns {Promise<{ uploaded: number, skipped: number, errors: number, mode: 'legacy' | 'noop' }>}
 */
export async function syncLocalAvatarsToS3OnStartup(avatarsDirAbs, opts = {}) {
    const log = opts.onLog || ((m) => console.log(`[s3-avatar-sync] ${m}`));
    if (!isS3ModelsBucketConfigured() || !fs.existsSync(avatarsDirAbs)) {
        return { uploaded: 0, skipped: 0, errors: 0, mode: 'noop' };
    }

    const disk = collectLocalAvatarDiskStateForSync(avatarsDirAbs);
    if (Object.keys(disk).length === 0) {
        return { uploaded: 0, skipped: 0, errors: 0, mode: 'noop' };
    }

    let uploaded = 0;
    let skipped = 0;
    let errors = 0;

    for (const posixRel of Object.keys(disk)) {
        const absFile = path.join(avatarsDirAbs, ...posixRel.split('/'));
        const key = s3KeyForAvatarRelative(posixRel);
        const isShortLivedMeta =
            posixRel === AVATAR_ACTIVE_META_REL_POSIX || posixRel.endsWith('/avatars-registry.json');
        try {
            const localMd5 = await md5FileHex(absFile);
            const remote = await headEtag(key);
            if (remote && !remote.includes('-') && remote.length === 32 && remote === localMd5) {
                skipped++;
                continue;
            }
            await uploadLocalAvatarFile(
                absFile,
                avatarsDirAbs,
                isShortLivedMeta ? MANIFEST_CACHE_CONTROL : DEFAULT_ASSET_CACHE_CONTROL,
            );
            uploaded++;
            log(`uploaded ${key}`);
        } catch (e) {
            errors++;
            console.error(`[s3-avatar-sync] failed ${key}:`, e);
        }
    }

    return { uploaded, skipped, errors, mode: 'legacy' };
}
