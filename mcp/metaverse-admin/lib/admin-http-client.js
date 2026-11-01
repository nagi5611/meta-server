// mcp/metaverse-admin/lib/admin-http-client.js — 管理パネル HTTP（Basic + CSRF）

const ADMIN_CSRF_HEADER = 'X-Admin-CSRF';
const MAX_BODY_CHARS = 120_000;

/** @type {{ token: string, expiresAt: number } | null} */
let adminCsrfCache = null;
/** @type {{ token: string, expiresAt: number } | null} */
let hostMonitorCsrfCache = null;

/**
 * @param {string} b64
 * @returns {string}
 */
function decodePasswordB64(b64) {
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    return Buffer.from(padded, 'base64').toString('utf8');
}

/**
 * meta / metair どちらの資格情報プレフィックスを使うか
 * @returns {'META_ADMIN' | 'METAIR_ADMIN'}
 */
function getCredentialPrefix() {
    const instance = String(process.env.META_ADMIN_INSTANCE ?? '').trim().toLowerCase();
    if (instance === 'metair') return 'METAIR_ADMIN';
    if (instance === 'meta') return 'META_ADMIN';

    const base = String(process.env.META_ADMIN_BASE_URL ?? '').toLowerCase();
    if (base.includes('metair.mmh-virtual.jp')) return 'METAIR_ADMIN';
    return 'META_ADMIN';
}

/**
 * 環境変数から管理者パスワードを得る（平文はログに出さない）
 * @returns {string}
 */
function readAdminPassword() {
    const prefix = getCredentialPrefix();
    const b64 = String(process.env[`${prefix}_PASSWORD_B64`] ?? '').trim();
    if (b64) {
        return decodePasswordB64(b64);
    }
    return String(process.env[`${prefix}_PASSWORD`] ?? '');
}

/**
 * @returns {string}
 */
export function getAdminBaseUrl() {
    return String(process.env.META_ADMIN_BASE_URL ?? 'https://meta.mmh-virtual.jp').replace(/\/$/, '');
}

/**
 * @returns {{ username: string, password: string }}
 */
export function getAdminCredentials() {
    const prefix = getCredentialPrefix();
    const usernameKey = prefix === 'METAIR_ADMIN' ? 'METAIR_ADMIN_USERNAME' : 'META_ADMIN_USERNAME';
    const username =
        String(process.env[usernameKey] ?? process.env.META_ADMIN_USERNAME ?? 'admin').trim() || 'admin';
    const password = readAdminPassword();
    if (password.length < 1) {
        throw new Error(
            `${prefix}_PASSWORD または ${prefix}_PASSWORD_B64 を MCP サーバーの env に設定してください`
        );
    }
    return { username, password };
}

/**
 * @returns {string}
 */
function buildBasicAuthorization() {
    const { username, password } = getAdminCredentials();
    const encoded = Buffer.from(`${username}:${password}`, 'utf8').toString('base64');
    return `Basic ${encoded}`;
}

/**
 * @param {string} path
 */
function assertAllowedPath(path) {
    if (
        !path.startsWith('/admin/') &&
        path !== '/admin/csrf-token' &&
        !path.startsWith('/host-monitor/')
    ) {
        throw new Error('path は /admin/... または /host-monitor/... のみ許可されています');
    }
}

/**
 * @param {'admin' | 'host-monitor'} scope
 * @returns {Promise<string>}
 */
async function getCsrfToken(scope) {
    const now = Date.now();
    const cache = scope === 'host-monitor' ? hostMonitorCsrfCache : adminCsrfCache;
    if (cache && cache.expiresAt > now + 30_000) {
        return cache.token;
    }

    const base = getAdminBaseUrl();
    const csrfPath =
        scope === 'host-monitor' ? '/host-monitor/api/csrf-token' : '/admin/csrf-token';
    const res = await fetch(`${base}${csrfPath}`, {
        method: 'GET',
        headers: { Authorization: buildBasicAuthorization(), Accept: 'application/json' },
    });
    const text = await res.text();
    if (!res.ok) {
        throw new Error(`CSRF 取得失敗 (${res.status}): ${text.slice(0, 500)}`);
    }
    let parsed;
    try {
        parsed = JSON.parse(text);
    } catch {
        throw new Error('CSRF 応答が JSON ではありません');
    }
    const token = typeof parsed.token === 'string' ? parsed.token : '';
    const expiresAt = typeof parsed.expiresAt === 'number' ? parsed.expiresAt : now + 3_600_000;
    if (!token) {
        throw new Error('CSRF トークンが応答に含まれていません');
    }
    const entry = { token, expiresAt };
    if (scope === 'host-monitor') {
        hostMonitorCsrfCache = entry;
    } else {
        adminCsrfCache = entry;
    }
    return token;
}

/**
 * @param {string} path
 * @returns {'admin' | 'host-monitor'}
 */
function csrfScopeForPath(path) {
    return path.startsWith('/host-monitor/') ? 'host-monitor' : 'admin';
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function formatResponseBody(value) {
    if (value === null || value === undefined) return '';
    if (typeof value === 'string') {
        return value.length > MAX_BODY_CHARS ? `${value.slice(0, MAX_BODY_CHARS)}\n…(truncated)` : value;
    }
    const json = JSON.stringify(value, null, 2);
    return json.length > MAX_BODY_CHARS ? `${json.slice(0, MAX_BODY_CHARS)}\n…(truncated)` : json;
}

/**
 * @param {string} method
 * @param {string} path
 * @param {{ query?: Record<string, string | number | boolean | undefined>, body?: unknown, confirmWrite?: boolean }} [opts]
 * @returns {Promise<{ status: number, ok: boolean, bodyText: string, contentType: string | null }>}
 */
export async function adminHttpRequest(method, path, opts = {}) {
    assertAllowedPath(path);
    const upper = String(method || 'GET').toUpperCase();
    if (!['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(upper)) {
        throw new Error(`未対応の HTTP メソッド: ${upper}`);
    }

    const isMutating = !['GET', 'HEAD', 'OPTIONS'].includes(upper);
    if (isMutating && opts.confirmWrite !== true) {
        throw new Error(
            '変更系リクエストには confirmWrite: true が必要です（kick・再起動・worlds 保存など）'
        );
    }

    const base = getAdminBaseUrl();
    const url = new URL(path, `${base}/`);
    if (opts.query) {
        for (const [k, v] of Object.entries(opts.query)) {
            if (v === undefined || v === null) continue;
            url.searchParams.set(k, String(v));
        }
    }

    /** @type {Record<string, string>} */
    const headers = {
        Authorization: buildBasicAuthorization(),
        Accept: 'application/json, text/plain, */*',
    };

    let bodyPayload;
    if (isMutating && opts.body !== undefined) {
        headers['Content-Type'] = 'application/json';
        bodyPayload = JSON.stringify(opts.body);
    }

    if (isMutating) {
        const csrf = await getCsrfToken(csrfScopeForPath(path));
        headers[ADMIN_CSRF_HEADER] = csrf;
    }

    const res = await fetch(url.toString(), {
        method: upper,
        headers,
        body: bodyPayload,
    });

    const contentType = res.headers.get('content-type');
    const raw = await res.text();
    let bodyText = raw;
    if (contentType && contentType.includes('application/json') && raw) {
        try {
            bodyText = formatResponseBody(JSON.parse(raw));
        } catch {
            bodyText = formatResponseBody(raw);
        }
    } else {
        bodyText = formatResponseBody(raw);
    }

    return {
        status: res.status,
        ok: res.ok,
        bodyText,
        contentType,
    };
}
