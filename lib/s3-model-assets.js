// lib/s3-model-assets.js — モデルファイルの S3 アップロード・起動時同期・公開 CDN URL 構築
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { S3Client, PutObjectCommand, HeadObjectCommand, DeleteObjectCommand, GetObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import {
    AWS_REGION,
    S3_BUCKET,
    normalizedS3KeyPrefix,
    normalizedCdnBaseUrl,
    isS3ModelsBucketConfigured,
    getS3ModelsUploadConcurrency,
} from '../config/s3-assets.js';

/** 起動時同期用マニフェスト（models 直下相対 posix）。実体は JSON。S3 とローカル _meta に同一内容を置く */
export const S3_SYNC_MANIFEST_REL_POSIX = '_meta/s3-sync-manifest.json';

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
    if (!isS3ModelsBucketConfigured()) {
        throw new Error('[s3-model-assets] S3 bucket not configured (USE_S3_MODELS, AWS_REGION, META_MODELS_S3_BUCKET)');
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
    if (!isS3ModelsBucketConfigured() || keys.length === 0) return;
    const cli = getS3Client();
    await Promise.all(
        keys.map((key) =>
            cli.send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: key })).catch(() => {})
        )
    );
}

/**
 * ローカルの絶対パス群を S3 に送る。途中失敗時は送信済みキーを削除する。
 * 同一バッチ内は META_MODELS_S3_UPLOAD_CONCURRENCY 本まで並列 Put（既定 16）
 * @param {string[]} localAbsPaths
 * @param {string} modelsDirAbs
 */
export async function uploadLocalModelsPathsOrRollbackS3(localAbsPaths, modelsDirAbs) {
    const concurrency = getS3ModelsUploadConcurrency();
    /** @type {string[]} */
    const uploaded = [];
    try {
        for (let i = 0; i < localAbsPaths.length; i += concurrency) {
            const batch = localAbsPaths.slice(i, i + concurrency);
            const settled = await Promise.allSettled(
                batch.map((abs) => uploadLocalModelsFile(abs, modelsDirAbs)),
            );
            /** @type {string[]} */
            const batchKeys = [];
            /** @type {unknown} */
            let firstRejection = undefined;
            for (let j = 0; j < settled.length; j++) {
                const s = settled[j];
                if (s.status === 'fulfilled') {
                    batchKeys.push(s.value);
                    continue;
                }
                if (firstRejection === undefined) {
                    firstRejection = s.reason;
                }
            }
            if (firstRejection !== undefined) {
                await deleteS3ObjectsByKeys([...uploaded, ...batchKeys]);
                throw firstRejection;
            }
            uploaded.push(...batchKeys);
        }
    } catch (e) {
        await deleteS3ObjectsByKeys(uploaded);
        throw e;
    }
}

/**
 * models 直下の相対 POSIX パスに対応する S3 オブジェクトを削除（管理画面のローカル削除と向き合わせ）
 * @param {string[]} relativePosixList
 * @returns {Promise<void>}
 */
export async function deleteS3ModelObjectsByRelativePosix(relativePosixList) {
    if (!isS3ModelsBucketConfigured() || !relativePosixList?.length) return;
    const keys = relativePosixList.map((r) =>
        s3KeyForModelsRelative(String(r || '').replace(/^\/+/, '').replace(/\\/g, '/')),
    );
    await deleteS3ObjectsByKeys(keys);
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
 * @param {string} posixRel models からの相対
 * @returns {boolean}
 */
function isUnderReservedMetaSync(posixRel) {
    return posixRel === '_meta' || posixRel.startsWith('_meta/');
}

/**
 * models 配下を再帰走査し `_meta/` を除く全ファイルの mtimeMs・ファイル名を集める
 * @param {string} modelsDirAbs
 * @returns {Record<string, { mtimeMs: number, name: string }>}
 */
export function collectLocalDiskModelStateForSync(modelsDirAbs) {
    /** @type {Record<string, { mtimeMs: number, name: string }>} */
    const out = {};
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
        const posixRel = rel.split(path.sep).join('/');
        if (isUnderReservedMetaSync(posixRel)) continue;

        for (const ent of entries) {
            const subRel = rel ? `${rel}/${ent.name}` : ent.name;
            const subPosix = subRel.split(path.sep).join('/');
            if (ent.isDirectory()) {
                if (isUnderReservedMetaSync(subPosix)) continue;
                stack.push(subRel);
                continue;
            }
            if (!ent.isFile()) continue;
            if (isUnderReservedMetaSync(subPosix)) continue;
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
 * @param {Record<string, { mtimeMs: number, name: string }>} diskState
 * @returns {object}
 */
function buildManifestPayload(diskState) {
    /** @type {Record<string, { mtimeMs: number, name: string }>} */
    const files = {};
    for (const [p, meta] of Object.entries(diskState)) {
        files[p] = { mtimeMs: meta.mtimeMs, name: meta.name };
    }
    return {
        v: 1,
        generatedAt: new Date().toISOString(),
        files,
    };
}

/**
 * ローカル `_meta/s3-sync-manifest.json` を読む
 * @param {string} modelsDirAbs
 * @returns {object | null}
 */
function readLocalSyncManifest(modelsDirAbs) {
    const abs = path.join(modelsDirAbs, ...S3_SYNC_MANIFEST_REL_POSIX.split('/'));
    try {
        if (!fs.existsSync(abs)) return null;
        const raw = fs.readFileSync(abs, 'utf8');
        return JSON.parse(raw);
    } catch {
        return null;
    }
}

/**
 * S3 上の同期マニフェストを取得してパースする
 * @returns {Promise<object | null>}
 */
async function fetchRemoteSyncManifestParsed() {
    if (!isS3ModelsBucketConfigured()) return null;
    const key = s3KeyForModelsRelative(S3_SYNC_MANIFEST_REL_POSIX);
    try {
        const cli = getS3Client();
        const out = await cli.send(new GetObjectCommand({ Bucket: S3_BUCKET, Key: key }));
        if (!out.Body) return null;
        let str;
        if (typeof out.Body.transformToString === 'function') {
            str = await out.Body.transformToString('utf-8');
        } else {
            const chunks = [];
            for await (const ch of /** @type {AsyncIterable<Buffer>} */ (out.Body)) {
                chunks.push(Buffer.from(ch));
            }
            str = Buffer.concat(chunks).toString('utf8');
        }
        const j = JSON.parse(str);
        return j && typeof j === 'object' ? j : null;
    } catch {
        return null;
    }
}

/**
 * マニフェスト JSON をローカルと S3 に書く
 * @param {string} modelsDirAbs
 * @param {object} payload
 */
async function persistSyncManifest(modelsDirAbs, payload) {
    const jsonStr = `${JSON.stringify(payload)}\n`;
    const relParts = S3_SYNC_MANIFEST_REL_POSIX.split('/');
    const dirAbs = path.join(modelsDirAbs, ...relParts.slice(0, -1));
    const fileAbs = path.join(modelsDirAbs, ...relParts);
    fs.mkdirSync(dirAbs, { recursive: true });
    await fs.promises.writeFile(fileAbs, jsonStr, 'utf8');

    const cli = getS3Client();
    await cli.send(
        new PutObjectCommand({
            Bucket: S3_BUCKET,
            Key: s3KeyForModelsRelative(S3_SYNC_MANIFEST_REL_POSIX),
            Body: Buffer.from(jsonStr, 'utf8'),
            ContentType: 'application/json; charset=utf-8',
        }),
    );
}

/**
 * ListObjects でプレフィックス配下を列挙し、同期集合に無いオブジェクトを削除（レガシー後の掃除）
 * @param {Set<string>} allowedPosixRel
 * @param {(msg: string) => void} log
 * @returns {Promise<number>}
 */
async function deleteS3OrphanModelKeys(allowedPosixRel, log) {
    const prefRaw = normalizedS3KeyPrefix();
    const pref = prefRaw.replace(/^\/+|\/+$/g, '');
    const listPrefix = pref ? `${pref}/` : '';
    let token = /** @type {string | undefined} */ (undefined);
    let n = 0;
    const cli = getS3Client();
    do {
        const out = await cli.send(
            new ListObjectsV2Command({
                Bucket: S3_BUCKET,
                Prefix: listPrefix,
                ContinuationToken: token,
            }),
        );
        const contents = out.Contents || [];
        for (const obj of contents) {
            const key = obj.Key;
            if (!key || typeof key !== 'string') continue;
            if (key.endsWith('/')) continue;
            const posixRel =
                listPrefix && key.startsWith(listPrefix) ? key.slice(listPrefix.length) : key.replace(/^\/+/, '');
            if (!posixRel) continue;
            if (posixRel === S3_SYNC_MANIFEST_REL_POSIX) continue;
            if (allowedPosixRel.has(posixRel)) continue;
            await cli.send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: key }));
            n++;
            log(`deleted (sync-orphan) ${key}`);
        }
        token = out.IsTruncated ? out.NextContinuationToken : undefined;
    } while (token);
    return n;
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
 * マニフェスト未整備時: 全ファイルを MD5 と Head で突き合わせ、終了後に List で孤児を削除
 * @param {string} modelsDirAbs
 * @param {{ onLog?: (msg: string) => void }} opts
 * @returns {Promise<{ uploaded: number, skipped: number, deleted: number, errors: number }>}
 */
async function syncStartupLegacyMd5AndHead(modelsDirAbs, opts = {}) {
    const log = opts.onLog || ((m) => console.log(`[s3-sync] ${m}`));
    const disk = collectLocalDiskModelStateForSync(modelsDirAbs);
    let uploaded = 0;
    let skipped = 0;
    let errors = 0;

    for (const posixRel of Object.keys(disk)) {
        const absFile = path.join(modelsDirAbs, ...posixRel.split('/'));
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
            log(`uploaded (sync-legacy) ${key}`);
        } catch (e) {
            errors++;
            console.error(`[s3-sync] legacy failed ${key}:`, e);
        }
    }

    let deletedOrphans = 0;
    if (errors === 0) {
        try {
            deletedOrphans = await deleteS3OrphanModelKeys(new Set(Object.keys(disk)), log);
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            console.warn(
                '[s3-sync] orphan cleanup skipped (needs s3:ListBucket on the models bucket, often denied by minimal IAM). S3 にマニフェスト外の孤児キーが残る場合があります。Policy 例: docs/setup-s3-cloudfront-models.md Detail:',
                msg,
            );
        }
    }
    return { uploaded, skipped, deleted: deletedOrphans, errors };
}

/**
 * 起動時: マニフェスト比較で S3 とローカル models を同期（欠損・mtime 不一致・マニフェスト上の孤立パスを削除）。
 * リモートマニフェストが無い・不正な場合は 1 回だけ MD5+Head+List 同期へフォールバックする。
 * @param {string} modelsDirAbs
 * @param {{ onLog?: (msg: string) => void }} [opts]
 * @returns {Promise<{ uploaded: number, skipped: number, deleted: number, errors: number, mode: 'manifest' | 'legacy' | 'noop' }>}
 */
export async function syncLocalModelsToS3OnStartup(modelsDirAbs, opts = {}) {
    const log = opts.onLog || ((m) => console.log(`[s3-sync] ${m}`));
    if (!isS3ModelsBucketConfigured() || !fs.existsSync(modelsDirAbs)) {
        return { uploaded: 0, skipped: 0, deleted: 0, errors: 0, mode: 'noop' };
    }

    const concurrency = getS3ModelsUploadConcurrency();
    const diskState = collectLocalDiskModelStateForSync(modelsDirAbs);
    const remoteParsed = await fetchRemoteSyncManifestParsed();
    const remoteFiles =
        remoteParsed && remoteParsed.v === 1 && remoteParsed.files && typeof remoteParsed.files === 'object'
            ? /** @type {Record<string, { mtimeMs?: number }>} */ (remoteParsed.files)
            : null;

    if (remoteFiles === null) {
        log('remote manifest missing or invalid; running legacy MD5/Head sync + orphan cleanup');
        const leg = await syncStartupLegacyMd5AndHead(modelsDirAbs, opts);
        let errors = leg.errors;
        if (errors === 0) {
            try {
                const freshDisk = collectLocalDiskModelStateForSync(modelsDirAbs);
                const payload = buildManifestPayload(freshDisk);
                await persistSyncManifest(modelsDirAbs, payload);
                log('wrote local + S3 sync manifest after legacy sync');
            } catch (e) {
                errors++;
                console.error('[s3-sync] manifest write after legacy failed:', e);
            }
        }
        return {
            uploaded: leg.uploaded,
            skipped: leg.skipped,
            deleted: leg.deleted,
            errors,
            mode: 'legacy',
        };
    }

    /** @type {string[]} */
    const toUpload = [];
    for (const [p, meta] of Object.entries(diskState)) {
        const rm = remoteFiles[p];
        if (!rm || Number(rm.mtimeMs) !== meta.mtimeMs) toUpload.push(p);
    }
    /** @type {string[]} */
    const toDelete = [];
    for (const p of Object.keys(remoteFiles)) {
        if (!(p in diskState)) toDelete.push(p);
    }

    const preSkipped = Math.max(0, Object.keys(diskState).length - toUpload.length);

    if (toUpload.length === 0 && toDelete.length === 0) {
        const localM = readLocalSyncManifest(modelsDirAbs);
        const payload = buildManifestPayload(diskState);
        const needLocalWrite =
            !localM ||
            localM.v !== 1 ||
            JSON.stringify(localM.files) !== JSON.stringify(payload.files);
        if (needLocalWrite) {
            try {
                await persistSyncManifest(modelsDirAbs, payload);
                log('refreshed sync manifest (local drift or missing file)');
            } catch (e) {
                console.error('[s3-sync] manifest refresh failed:', e);
                return { uploaded: 0, skipped: preSkipped, deleted: 0, errors: 1, mode: 'manifest' };
            }
        }
        return { uploaded: 0, skipped: preSkipped, deleted: 0, errors: 0, mode: 'noop' };
    }

    let uploaded = 0;
    let deleted = 0;
    let errors = 0;

    for (let i = 0; i < toUpload.length; i += concurrency) {
        const batch = toUpload.slice(i, i + concurrency);
        const settled = await Promise.allSettled(
            batch.map(async (posixRel) => {
                const absFile = path.join(modelsDirAbs, ...posixRel.split('/'));
                await uploadLocalModelsFile(absFile, modelsDirAbs);
                log(`uploaded (sync) ${s3KeyForModelsRelative(posixRel)}`);
            }),
        );
        for (const s of settled) {
            if (s.status === 'fulfilled') uploaded++;
            else {
                errors++;
                console.error('[s3-sync] upload failed:', s.reason);
            }
        }
    }

    for (let i = 0; i < toDelete.length; i += concurrency) {
        const batch = toDelete.slice(i, i + concurrency);
        const settled = await Promise.allSettled(
            batch.map((posixRel) => {
                const key = s3KeyForModelsRelative(posixRel);
                return getS3Client()
                    .send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: key }))
                    .then(() => {
                        deleted++;
                        log(`deleted (sync) ${key}`);
                    });
            }),
        );
        for (const s of settled) {
            if (s.status === 'rejected') {
                errors++;
                console.error('[s3-sync] delete failed:', s.reason);
            }
        }
    }

    if (errors === 0) {
        try {
            const freshDisk = collectLocalDiskModelStateForSync(modelsDirAbs);
            await persistSyncManifest(modelsDirAbs, buildManifestPayload(freshDisk));
        } catch (e) {
            errors++;
            console.error('[s3-sync] manifest persist after manifest sync failed:', e);
        }
    }

    return { uploaded, skipped: preSkipped, deleted, errors, mode: 'manifest' };
}
