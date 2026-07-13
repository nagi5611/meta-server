// public/js/login-preload-state.js — ログイン画面プリロードの sessionStorage 状態（軽量）

/** ログイン画面で取得したプリロードを「新鮮」とみなす時間（体験する押下から±この範囲で完了したデータ） */
export const LOGIN_PRELOAD_FRESH_MS = 60_000;

const LOGIN_PRELOAD_STORAGE_KEY = 'metaverse_login_preload_v1';

/**
 * @returns {{ worldId?: string, completedAt?: number, entryClickAt?: number } | null}
 */
function readLoginPreloadState() {
    try {
        const raw = sessionStorage.getItem(LOGIN_PRELOAD_STORAGE_KEY);
        if (!raw) return null;
        const j = JSON.parse(raw);
        return j && typeof j === 'object' ? j : null;
    } catch {
        return null;
    }
}

/**
 * @param {Partial<{ worldId: string, completedAt: number, entryClickAt: number }>} patch
 */
function writeLoginPreloadState(patch) {
    try {
        const prev = readLoginPreloadState() || {};
        sessionStorage.setItem(
            LOGIN_PRELOAD_STORAGE_KEY,
            JSON.stringify({ ...prev, ...patch })
        );
    } catch {
        /* ignore */
    }
}

/**
 * 「体験する」「ログイン」押下時刻を記録（鮮度判定用）
 */
export function recordLoginEntryClick() {
    writeLoginPreloadState({ entryClickAt: Date.now() });
}

/**
 * ログイン画面でのプリロード完了を記録
 * @param {string} worldId
 */
export function markLoginPreloadComplete(worldId) {
    const id = String(worldId || '').trim();
    if (!id) return;
    writeLoginPreloadState({ worldId: id, completedAt: Date.now() });
}

/**
 * ログイン〜入場直後にプリロード再取得を省略できるか
 * @param {string} [expectedWorldId] 省略時はワールド ID 一致を見ない
 * @returns {boolean}
 */
export function isLoginPreloadFresh(expectedWorldId) {
    const s = readLoginPreloadState();
    if (!s?.completedAt || !s?.worldId || !s?.entryClickAt) return false;

    const now = Date.now();
    if (now - s.completedAt > LOGIN_PRELOAD_FRESH_MS) return false;
    if (Math.abs(s.entryClickAt - s.completedAt) > LOGIN_PRELOAD_FRESH_MS) return false;

    const expected = String(expectedWorldId || '').trim();
    if (expected && s.worldId !== expected) return false;

    return true;
}

/**
 * 鮮度フラグを破棄（ワールド切替後など）
 */
export function clearLoginPreloadState() {
    try {
        sessionStorage.removeItem(LOGIN_PRELOAD_STORAGE_KEY);
    } catch {
        /* ignore */
    }
}
