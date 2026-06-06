// lib/cloudfront-cache-invalidation.js — CloudFront エッジキャッシュの明示無効化（任意）
import { CloudFrontClient, CreateInvalidationCommand } from '@aws-sdk/client-cloudfront';
import { CLOUDFRONT_DISTRIBUTION_ID, USE_S3_MODELS } from '../config/s3-assets.js';

/** @type {import('@aws-sdk/client-cloudfront').CloudFrontClient | null} */
let cfSingleton = null;

/**
 * @returns {import('@aws-sdk/client-cloudfront').CloudFrontClient}
 */
function getCloudFrontClient() {
    if (!cfSingleton) {
        cfSingleton = new CloudFrontClient({ region: 'us-east-1' });
    }
    return cfSingleton;
}

/**
 * CDN 絶対 URL から無効化パス（pathname）を取り出す
 * @param {string} absoluteUrl
 * @returns {string | null}
 */
function pathnameFromCdnUrl(absoluteUrl) {
    try {
        const p = new URL(absoluteUrl).pathname;
        return p && p.startsWith('/') ? p : null;
    } catch {
        return null;
    }
}

/**
 * CloudFront 上のオブジェクトパスを無効化する（CLOUDFRONT_DISTRIBUTION_ID 未設定時は no-op）
 * @param {string[]} absoluteUrls HTTPS の CDN URL（署名付きでなくてよい）
 * @returns {Promise<void>}
 */
export async function invalidateCloudFrontPathsFromUrls(absoluteUrls) {
    if (!USE_S3_MODELS || !CLOUDFRONT_DISTRIBUTION_ID) return;
    const paths = [...new Set((absoluteUrls || []).map(pathnameFromCdnUrl).filter(Boolean))];
    if (paths.length === 0) return;

    const cli = getCloudFrontClient();
    await cli.send(
        new CreateInvalidationCommand({
            DistributionId: CLOUDFRONT_DISTRIBUTION_ID,
            InvalidationBatch: {
                CallerReference: `meta-avatar-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
                Paths: {
                    Quantity: paths.length,
                    Items: paths,
                },
            },
        }),
    );
}
