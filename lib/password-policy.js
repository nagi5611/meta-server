// lib/password-policy.js — 管理画面から作成するユーザー向けパスワード強度
const MIN_DEV_LENGTH = 8;
const MIN_PROD_LENGTH = 12;

/**
 * @returns {boolean}
 */
function isNodeProduction() {
    return process.env.NODE_ENV === 'production';
}

/**
 * @param {unknown} password
 * @returns {{ ok: true } | { ok: false, error: string, minLength: number }}
 */
export function validateUserPassword(password) {
    const s = String(password ?? '');
    if (!s || s.trim() !== s) {
        return { ok: false, error: 'password_invalid', minLength: isNodeProduction() ? MIN_PROD_LENGTH : MIN_DEV_LENGTH };
    }
    const minLength = isNodeProduction() ? MIN_PROD_LENGTH : MIN_DEV_LENGTH;
    if (s.length < minLength) {
        return { ok: false, error: 'password_too_short', minLength };
    }
    return { ok: true };
}

/**
 * @returns {number}
 */
export function getUserPasswordMinLength() {
    return isNodeProduction() ? MIN_PROD_LENGTH : MIN_DEV_LENGTH;
}
