// lib/chat-moderation-jev.js — チャット一次モデレーション（TypeSafe Jev / System One）

/** @see https://jevai.website/ja/use-cases/content-moderation */
export const DEFAULT_JEV_API_URL = 'https://jevai.website/api/v1/systemone';

const DEFAULT_TIMEOUT_MS = Number(process.env.JEV_MODERATION_TIMEOUT_MS) || 8000;
const DEFAULT_THRESHOLD = Number(process.env.JEV_THRESHOLD);

const DEFAULT_NOUL_INSTRUCTIONS =
    'このチャット1行は、オンライン空間の不適切投稿（ヘイト・重度の暴言・露骨な性的表現・他者への暴力的脅し・スパム・個人情報の悪意ある晒しなど）に該当するか？';

/**
 * JEV 一次判定が有効か（API キーのみ必須。URL は公式デフォルト）
 * @returns {boolean}
 */
export function isJevChatModerationEnabled() {
    return Boolean(String(process.env.JEV_API_KEY || '').trim());
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
 * @returns {string}
 */
export function resolveJevApiUrl() {
    const fromEnv = String(process.env.JEV_API_URL || '').trim();
    return fromEnv || DEFAULT_JEV_API_URL;
}

/**
 * Jev 応答から Noul 確率（「はい」= 有害）を取り出す
 * @param {unknown} body
 * @param {string} questionId
 * @returns {number | null}
 */
export function extractJevNoulScore(body, questionId = 'harmful') {
    if (body == null || typeof body !== 'object') return null;
    const o = /** @type {Record<string, unknown>} */ (body);

    const direct = o[questionId];
    if (direct && typeof direct === 'object') {
        const noul = /** @type {{ noul?: unknown }} */ (direct).noul;
        if (typeof noul === 'number' && Number.isFinite(noul)) return noul;
    }

    const answers = o.answers;
    if (answers && typeof answers === 'object' && !Array.isArray(answers)) {
        const a = /** @type {Record<string, unknown>} */ (answers)[questionId];
        if (a && typeof a === 'object') {
            const noul = /** @type {{ noul?: unknown }} */ (a).noul;
            if (typeof noul === 'number' && Number.isFinite(noul)) return noul;
        }
    }

    for (const value of Object.values(o)) {
        if (value && typeof value === 'object' && !Array.isArray(value)) {
            const noul = /** @type {{ noul?: unknown }} */ (value).noul;
            if (typeof noul === 'number' && Number.isFinite(noul)) return noul;
        }
    }
    return null;
}

/**
 * 応答 JSON から allow/block を解釈する（Noul 優先、後方互換用の汎用形）
 * @param {unknown} body
 * @param {number} threshold この値以上のスコアは block（高い=有害）
 * @param {string} [questionId]
 * @returns {{ allow: boolean, score: number | null, reason: string | null }}
 */
export function interpretJevModerationResponse(body, threshold, questionId = 'harmful') {
    const noul = extractJevNoulScore(body, questionId);
    if (noul != null) {
        return {
            allow: noul < threshold,
            score: noul,
            reason: null,
        };
    }

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

    if (typeof o.score === 'number') {
        return {
            allow: o.score < threshold,
            score: o.score,
            reason: typeof o.reason === 'string' ? o.reason : null,
        };
    }

    return { allow: false, score: null, reason: 'unrecognized_response' };
}

/**
 * System One リクエスト本文を組み立てる
 * @param {string} text
 * @param {string} [historyTableText]
 */
export function buildJevSystemOneRequestBody(text, historyTableText) {
    const model = String(process.env.JEV_MODEL || 'jev-latest').trim() || 'jev-latest';
    const questionId = String(process.env.JEV_QUESTION_ID || 'harmful').trim() || 'harmful';
    const questionSetId = String(process.env.JEV_QUESTION_SET_ID || '').trim();

    const state = historyTableText
        ? `${historyTableText}\n\n=== 今回送信しようとしている1行 ===\n${text}`
        : text;

    if (questionSetId) {
        return { state, model, question_set_id: questionSetId };
    }

    const instructions =
        String(process.env.JEV_NOUL_INSTRUCTIONS || '').trim() || DEFAULT_NOUL_INSTRUCTIONS;

    return {
        state,
        model,
        questions: {
            [questionId]: {
                type: 'noul',
                instructions,
            },
        },
    };
}

/**
 * Jev API でチャット1行の一次判定
 * @param {{ text: string, historyTableText?: string, apiUrl?: string, apiKey?: string, threshold?: number, timeoutMs?: number, fetchImpl?: typeof fetch }} params
 * @returns {Promise<{ allow: boolean, score: number | null, reason: string | null, latencyMs: number }>}
 */
export async function jevPrimaryChatCheck(params) {
    const text = String(params.text || '').trim();
    const apiUrl = String(params.apiUrl || resolveJevApiUrl()).trim();
    const apiKey = String(params.apiKey || process.env.JEV_API_KEY || '').trim();
    const threshold = params.threshold ?? getJevThreshold();
    const timeoutMs = params.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const fetchFn = params.fetchImpl ?? fetch;
    const questionId = String(process.env.JEV_QUESTION_ID || 'harmful').trim() || 'harmful';

    if (!apiKey) {
        throw new Error('JEV_NOT_CONFIGURED');
    }

    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const headers = {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer ${apiKey}`,
    };

    const payload = buildJevSystemOneRequestBody(text, params.historyTableText);

    try {
        const res = await fetchFn(apiUrl, {
            method: 'POST',
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
        const { allow, score, reason } = interpretJevModerationResponse(parsed, threshold, questionId);
        return { allow, score, reason, latencyMs: Date.now() - started };
    } finally {
        clearTimeout(timer);
    }
}
