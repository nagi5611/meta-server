// lib/chat-moderation-jev.js — チャット一次モデレーション（JEV 外部 API・高速）

const DEFAULT_TIMEOUT_MS = Number(process.env.JEV_MODERATION_TIMEOUT_MS) || 4000;
const DEFAULT_THRESHOLD = Number(process.env.JEV_THRESHOLD);

/**
 * JEV 一次判定が有効か（URL と API キーが揃っているとき）
 * @returns {boolean}
 */
export function isJevChatModerationEnabled() {
    const url = String(process.env.JEV_API_URL || '').trim();
    const key = String(process.env.JEV_API_KEY || '').trim();
    return Boolean(url && key);
}

/**
 * @returns {number}
 */
export function getJevThreshold() {
    const n = DEFAULT_THRESHOLD;
    if (Number.isFinite(n) && n >= 0 && n <= 1) return n;
    return 0.5;
}

/**
 * 応答 JSON から allow/block を解釈する
 * @param {unknown} body
 * @param {number} threshold この値以上のスコアは block（高い=有害）
 * @returns {{ allow: boolean, score: number | null, reason: string | null }}
 */
export function interpretJevModerationResponse(body, threshold) {
    if (body == null || typeof body !== 'object') {
        return { allow: false, score: null, reason: 'invalid_response' };
    }
    const o = /** @type {Record<string, unknown>} */ (body);

    if (typeof o.allowed === 'boolean') {
        return {
            allow: o.allowed,
            score: typeof o.score === 'number' ? o.score : null,
            reason: typeof o.reason === 'string' ? o.reason : null,
        };
    }
    if (typeof o.allow === 'boolean') {
        return {
            allow: o.allow,
            score: typeof o.score === 'number' ? o.score : null,
            reason: typeof o.reason === 'string' ? o.reason : null,
        };
    }
    if (o.block === true || o.action === 'block' || o.decision === 'block') {
        return {
            allow: false,
            score: typeof o.score === 'number' ? o.score : null,
            reason: typeof o.reason === 'string' ? o.reason : null,
        };
    }
    if (o.action === 'allow' || o.decision === 'allow') {
        return {
            allow: true,
            score: typeof o.score === 'number' ? o.score : null,
            reason: null,
        };
    }

    if (typeof o.score === 'number') {
        const allow = o.score < threshold;
        return {
            allow,
            score: o.score,
            reason: typeof o.reason === 'string' ? o.reason : null,
        };
    }

    if (typeof o.toxicity === 'number') {
        const allow = o.toxicity < threshold;
        return {
            allow,
            score: o.toxicity,
            reason: typeof o.reason === 'string' ? o.reason : null,
        };
    }

    return { allow: false, score: null, reason: 'unrecognized_response' };
}

/**
 * JEV API でチャット1行の一次判定
 * @param {{ text: string, historyTableText?: string, apiUrl?: string, apiKey?: string, threshold?: number, timeoutMs?: number, fetchImpl?: typeof fetch }} params
 * @returns {Promise<{ allow: boolean, score: number | null, reason: string | null, latencyMs: number }>}
 */
export async function jevPrimaryChatCheck(params) {
    const text = String(params.text || '').trim();
    const apiUrl = String(params.apiUrl || process.env.JEV_API_URL || '').trim();
    const apiKey = String(params.apiKey || process.env.JEV_API_KEY || '').trim();
    const threshold = params.threshold ?? getJevThreshold();
    const timeoutMs = params.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const fetchFn = params.fetchImpl ?? fetch;

    if (!apiUrl || !apiKey) {
        throw new Error('JEV_NOT_CONFIGURED');
    }

    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const authHeader = String(process.env.JEV_API_KEY_HEADER || 'Authorization').trim();
    const authPrefix = String(process.env.JEV_API_KEY_PREFIX || 'Bearer ').trim();
    /** @type {Record<string, string>} */
    const headers = {
        'Content-Type': 'application/json',
        Accept: 'application/json',
    };
    if (authHeader.toLowerCase() === 'authorization') {
        headers.Authorization = `${authPrefix}${apiKey}`.trim();
    } else {
        headers[authHeader] = apiKey;
    }

    const payload = {
        text,
        message: text,
        ...(params.historyTableText
            ? { context: params.historyTableText, history: params.historyTableText }
            : {}),
    };

    try {
        const res = await fetchFn(apiUrl, {
            method: String(process.env.JEV_HTTP_METHOD || 'POST').toUpperCase(),
            headers,
            body: JSON.stringify(payload),
            signal: controller.signal,
        });
        const raw = await res.text();
        let parsed;
        try {
            parsed = raw ? JSON.parse(raw) : {};
        } catch {
            throw new Error(`JEV_BAD_JSON status=${res.status}`);
        }
        if (!res.ok) {
            throw new Error(`JEV_HTTP_${res.status}`);
        }
        const { allow, score, reason } = interpretJevModerationResponse(parsed, threshold);
        return { allow, score, reason, latencyMs: Date.now() - started };
    } finally {
        clearTimeout(timer);
    }
}
