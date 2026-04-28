// lib/cloudfront-signed-urls.js — CloudFront 閲覧用署名 URL 生成（@aws-sdk/cloudfront-signer）
import { getSignedUrl as cfGetSignedUrl } from '@aws-sdk/cloudfront-signer';
import {
    loadCloudFrontPrivateKeyPem,
    getCloudFrontSignExpiresSeconds,
    CLOUDFRONT_KEY_PAIR_ID,
} from '../config/s3-assets.js';

let cachedPrivateKeyPemPromise = /** @type {Promise<string>|null} */ (null);

/**
 * PEM をキャッシュ読み込み
 * @returns {Promise<string>}
 */
function getPrivateKeyCached() {
    if (!cachedPrivateKeyPemPromise) {
        cachedPrivateKeyPemPromise = loadCloudFrontPrivateKeyPem().catch((e) => {
            cachedPrivateKeyPemPromise = null;
            throw e;
        });
    }
    return cachedPrivateKeyPemPromise;
}

/**
 * 絶対 URL に CloudFront の署名クエリを付与する（閲覧用）
 * @param {string} absoluteUrl HTTPS のリソース URL（クエリ無し）
 * @returns {Promise<string>}
 */
export async function signCloudFrontGetUrl(absoluteUrl) {
    const keyId = CLOUDFRONT_KEY_PAIR_ID;
    if (!keyId) {
        throw new Error('[cloudfront-signed-urls] CLOUDFRONT_KEY_PAIR_ID unset');
    }
    const pk = await getPrivateKeyCached();
    const sec = getCloudFrontSignExpiresSeconds();
    const dateLessThan = new Date(Date.now() + sec * 1000);
    return cfGetSignedUrl({
        url: absoluteUrl,
        keyPairId: keyId,
        privateKey: pk,
        dateLessThan,
    });
}
