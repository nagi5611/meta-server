// config/s3-assets.js — S3 / CloudFront によるモデル二重保管（本番かつ USE_S3_MODELS で有効）
import fs from 'node:fs';

/**
 * env を真として解釈する（1 / true / yes / on）
 * @param {string | undefined} v
 * @returns {boolean}
 */
function isTruthyEnv(v) {
    const s = String(v ?? '').trim().toLowerCase();
    return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}

const isProduction = process.env.NODE_ENV === 'production';

/** 本番で S3+CloudFront のモデル配信モードになるか（開発では常に false） */
export const USE_S3_MODELS =
    isProduction && isTruthyEnv(process.env.USE_S3_MODELS);

/**
 * AWS / CDN 環境変数を読む
 * @param {string} name
 * @returns {string|null}
 */
function getEnvTrim(name) {
    const v = process.env[name];
    if (v == null || typeof v !== 'string') return null;
    const t = v.trim();
    return t !== '' ? t : null;
}

export const AWS_REGION = getEnvTrim('AWS_REGION');
export const S3_BUCKET = getEnvTrim('META_MODELS_S3_BUCKET') || getEnvTrim('AWS_S3_BUCKET');
/** S3 オブジェクトキー先頭（末尾スラッシュなしでも可）。例: prod/models */
export const S3_KEY_PREFIX_RAW = getEnvTrim('META_MODELS_S3_PREFIX') || 'models';

/** アバター GLB / active.json のキー先頭（モデルバケット内の別フォルダ）。例: prod/avatars */
export const AVATARS_S3_PREFIX_RAW = getEnvTrim('META_AVATARS_S3_PREFIX') || 'avatars';

/** IBL 用 HDR のキー先頭（モデルバケット内の別フォルダ）。例: prod/env */
export const ENV_S3_PREFIX_RAW = getEnvTrim('META_ENV_S3_PREFIX') || 'env';

/**
 * CloudFront の配送ドメイン（https:// で始める）
 * @type {string|null}
 */
export const CLOUDFRONT_BASE_URL_RAW = getEnvTrim('META_CDN_PUBLIC_BASE') || getEnvTrim('CLOUDFRONT_BASE_URL');

/** CloudFront 署名用キーペア ID */
export const CLOUDFRONT_KEY_PAIR_ID = getEnvTrim('CLOUDFRONT_KEY_PAIR_ID');
/** （任意）メタデータ JSON 更新時の CreateInvalidation 用ディストリビューション ID */
export const CLOUDFRONT_DISTRIBUTION_ID = getEnvTrim('CLOUDFRONT_DISTRIBUTION_ID');
/** PEM またはファイルパス */
const CLOUDFRONT_PRIVATE_KEY_PEM = getEnvTrim('CLOUDFRONT_PRIVATE_KEY');
const CLOUDFRONT_PRIVATE_KEY_PATH = getEnvTrim('CLOUDFRONT_PRIVATE_KEY_PATH');

/** 署名付き URL の有効秒数（既定 15 分） */
export function getCloudFrontSignExpiresSeconds() {
    const raw = process.env.CLOUDFRONT_SIGN_EXPIRES_SECONDS;
    if (!raw || String(raw).trim() === '') return 900;
    const n = parseInt(String(raw), 10);
    return Number.isFinite(n) && n >= 60 && n <= 86400 ? n : 900;
}

/**
 * 起動時 S3 同期で「ローカルに無いリモート」を Delete するか。
 * 同一バケットを複数インスタンスで共有する場合は 0 / false にする（他インスタンス分を消さない）。
 * 未設定時は 1（従来どおり削除あり）。管理画面からの明示削除はこの設定に関係なく S3 から消す。
 * @returns {boolean}
 */
export function isS3ModelsSyncPruneEnabled() {
    const raw = process.env.META_MODELS_S3_SYNC_PRUNE;
    if (raw === undefined || String(raw).trim() === '') return true;
    return isTruthyEnv(raw);
}

/** S3 への同時 PutObject 本数の上限（Prefab ZIP 等の一括アップロード用）。未設定時は 16。1〜128 にクランプ */
export function getS3ModelsUploadConcurrency() {
    const raw = process.env.META_MODELS_S3_UPLOAD_CONCURRENCY;
    if (raw === undefined || String(raw).trim() === '') return 16;
    const n = parseInt(String(raw).trim(), 10);
    if (!Number.isFinite(n) || n < 1) return 16;
    return Math.min(128, n);
}

/**
 * prefix を正規化（先頭および末尾スラッシュ除去後、DB には含めずキー構成にのみ使う）
 * @returns {string}
 */
export function normalizedS3KeyPrefix() {
    return S3_KEY_PREFIX_RAW.replace(/^\/+|\/+$/g, '');
}

/**
 * アバター用 S3 キー prefix（models と別フォルダ）
 * @returns {string}
 */
export function normalizedAvatarsS3KeyPrefix() {
    return AVATARS_S3_PREFIX_RAW.replace(/^\/+|\/+$/g, '');
}

/**
 * IBL（Radiance HDR）用 S3 キー prefix
 * @returns {string}
 */
export function normalizedEnvS3KeyPrefix() {
    return ENV_S3_PREFIX_RAW.replace(/^\/+|\/+$/g, '');
}

/**
 * @returns {string}
 */
export function normalizedCdnBaseUrl() {
    const b = CLOUDFRONT_BASE_URL_RAW || '';
    return b.replace(/\/+$/, '');
}

/** @returns {Promise<string>} PEM 全文 */
export async function loadCloudFrontPrivateKeyPem() {
    if (CLOUDFRONT_PRIVATE_KEY_PEM && CLOUDFRONT_PRIVATE_KEY_PEM.includes('BEGIN')) {
        return CLOUDFRONT_PRIVATE_KEY_PEM.replace(/\\n/g, '\n');
    }
    if (CLOUDFRONT_PRIVATE_KEY_PATH) {
        return fs.promises.readFile(CLOUDFRONT_PRIVATE_KEY_PATH, 'utf8');
    }
    throw new Error('[s3-assets] CloudFront signing: set CLOUDFRONT_PRIVATE_KEY (PEM) or CLOUDFRONT_PRIVATE_KEY_PATH');
}

/** @returns {boolean} */
export function isS3ModelsConfigComplete() {
    if (!USE_S3_MODELS) return false;
    return !!(AWS_REGION && S3_BUCKET && CLOUDFRONT_BASE_URL_RAW && CLOUDFRONT_KEY_PAIR_ID);
}

/**
 * PutObject / DeleteObject / 起動時同期に最低限必要な設定（CloudFront 署名は不要）
 * @returns {boolean}
 */
export function isS3ModelsBucketConfigured() {
    if (!USE_S3_MODELS) return false;
    return !!(AWS_REGION && S3_BUCKET);
}

if (USE_S3_MODELS && !(AWS_REGION && S3_BUCKET && CLOUDFRONT_BASE_URL_RAW)) {
    console.warn(
        '[s3-assets] USE_S3_MODELS=1 but AWS_REGION / META_MODELS_S3_BUCKET / META_CDN_PUBLIC_BASE (or CLOUDFRONT_BASE_URL) is incomplete.',
    );
}
