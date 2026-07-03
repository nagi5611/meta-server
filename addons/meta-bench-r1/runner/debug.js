// addons/meta-bench-r1/runner/debug.js — Runner 共通ログ（--debug）

let debugEnabled = false;

/**
 * @param {boolean} enabled
 */
export function configureRunnerDebug(enabled) {
    debugEnabled = !!enabled;
}

/**
 * @returns {boolean}
 */
export function isRunnerDebug() {
    return debugEnabled;
}

/**
 * @param {string} tag
 * @param {...unknown} args
 */
export function runnerDebug(tag, ...args) {
    if (!debugEnabled) return;
    console.log(`[runner:debug:${tag}]`, ts(), ...args);
}

/**
 * @param {string} tag
 * @param {...unknown} args
 */
export function runnerInfo(tag, ...args) {
    console.log(`[runner:${tag}]`, ts(), ...args);
}

/**
 * @param {string} tag
 * @param {...unknown} args
 */
export function runnerWarn(tag, ...args) {
    console.warn(`[runner:warn:${tag}]`, ts(), ...args);
}

/**
 * @param {string} tag
 * @param {...unknown} args
 */
export function runnerError(tag, ...args) {
    console.error(`[runner:error:${tag}]`, ts(), ...args);
}

/**
 * @param {unknown} err
 * @returns {string}
 */
export function formatError(err) {
    if (err instanceof Error) {
        const e = /** @type {Error & { data?: unknown; description?: unknown; type?: string }} */ (err);
        const parts = [e.message];
        if (e.data != null) parts.push(`data=${JSON.stringify(e.data)}`);
        if (e.description != null) parts.push(`description=${String(e.description)}`);
        if (e.type) parts.push(`type=${e.type}`);
        if (e.cause) parts.push(`cause=${formatError(e.cause)}`);
        return parts.join(' | ');
    }
    return String(err);
}

/**
 * @param {string | undefined} secret
 */
export function maskSecret(secret) {
    if (!secret || typeof secret !== 'string') return '(none)';
    if (secret.length <= 4) return '****';
    return `${secret.slice(0, 2)}…${secret.slice(-2)} (${secret.length} chars)`;
}

/**
 * @returns {string}
 */
function ts() {
    return new Date().toISOString();
}
