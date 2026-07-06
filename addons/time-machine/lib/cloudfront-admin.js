// addons/time-machine/lib/cloudfront-admin.js — プレフィックス一括 invalidation
import {
    S3_KEY_PREFIX_RAW,
    AVATARS_S3_PREFIX_RAW,
    ENV_S3_PREFIX_RAW,
    USE_S3_MODELS,
    CLOUDFRONT_DISTRIBUTION_ID,
} from '../../../config/s3-assets.js';
import { invalidateCloudFrontPathPrefixes } from '../../../lib/cloudfront-cache-invalidation.js';

/**
 * CDN 配下の主要プレフィックスを組み立てる
 * @returns {string[]}
 */
export function buildAssetInvalidationPrefixes() {
    const modelsPrefix = (S3_KEY_PREFIX_RAW || 'models').replace(/\/+$/, '');
    const planePrefix = `${modelsPrefix}/plane`;
    const avatarsPrefix = (AVATARS_S3_PREFIX_RAW || 'avatars').replace(/\/+$/, '');
    const envPrefix = (ENV_S3_PREFIX_RAW || 'env').replace(/\/+$/, '');

    return [`/${modelsPrefix}/*`, `/${planePrefix}/*`, `/${avatarsPrefix}/*`, `/${envPrefix}/*`];
}

/**
 * @returns {Promise<{ ok: boolean, prefixes?: string[], skipped?: boolean, error?: string }>}
 */
export async function invalidateAllAssetPrefixes() {
    if (!USE_S3_MODELS) {
        return { ok: true, skipped: true };
    }
    if (!CLOUDFRONT_DISTRIBUTION_ID) {
        return { ok: false, error: 'CLOUDFRONT_DISTRIBUTION_ID unset' };
    }
    const prefixes = buildAssetInvalidationPrefixes();
    try {
        await invalidateCloudFrontPathPrefixes(prefixes);
        return { ok: true, prefixes };
    } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
}
