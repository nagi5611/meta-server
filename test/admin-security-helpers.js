// test/admin-security-helpers.js — admin-database-explorer のマスク判定テスト用
/** @type {Set<string>} */
const SENSITIVE_COLUMN_EXACT = new Set([
    'password_hash',
    'password',
    'secret',
    'token',
    'api_key',
    'session_id',
    'private_key',
    'credential',
    'auth_token',
]);

/** @type {string[]} */
const SENSITIVE_COLUMN_SUFFIXES = ['_hash', '_secret', '_token', '_key'];

/**
 * @param {string} columnName
 * @returns {boolean}
 */
function isSensitiveColumn(columnName) {
    const lower = String(columnName).toLowerCase();
    if (SENSITIVE_COLUMN_EXACT.has(lower)) return true;
    return SENSITIVE_COLUMN_SUFFIXES.some((suffix) => lower.endsWith(suffix));
}

/**
 * @param {unknown} value
 * @param {string} columnName
 */
export function serializeCellForTest(value, columnName) {
    if (isSensitiveColumn(columnName)) {
        return { value: null, redacted: true };
    }
    return { value, redacted: false };
}
