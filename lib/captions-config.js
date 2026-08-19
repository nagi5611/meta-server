// lib/captions-config.js — リアルタイム音声字幕（Speech-to-Text）の有効化フラグと資格情報解決
// 認証は GEMINI_API_KEY とは別系統（GCP サービスアカウント）。config/s3-assets.js の資格情報パターンに倣う。

/**
 * env を真として解釈する（1 / true / yes / on）
 * @param {string | undefined} v
 * @returns {boolean}
 */
function isTruthyEnv(v) {
    const s = String(v ?? '').trim().toLowerCase();
    return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}

/**
 * @param {string} name
 * @returns {string|null}
 */
function getEnvTrim(name) {
    const v = process.env[name];
    if (v == null || typeof v !== 'string') return null;
    const t = v.trim();
    return t !== '' ? t : null;
}

/** 字幕機能そのものの有効化（既定 OFF、opt-in）。資格情報が別途必要。 */
export const CAPTIONS_ENABLED = isTruthyEnv(process.env.ENABLE_CAPTIONS);

/** STT プロバイダ: 'google'（既定）または 'mock'（資格情報不要のテスト用スタブ） */
export const CAPTIONS_STT_PROVIDER = (getEnvTrim('CAPTIONS_STT_PROVIDER') || 'google').toLowerCase();

/** 認識言語（既定 ja-JP）。多言語は Chirp 系モデル＋話者ロケールで拡張予定。 */
export const CAPTIONS_LANGUAGE_CODE = getEnvTrim('GOOGLE_SPEECH_LANGUAGE_CODE') || 'ja-JP';

/** 使用モデル（未設定なら API 既定。例: latest_long / chirp_2）。 */
export const CAPTIONS_MODEL = getEnvTrim('GOOGLE_SPEECH_MODEL') || null;

/** interim をクライアントへ配信する最小間隔(ms)。無駄な処理・帯域を抑制。 */
export function getCaptionInterimThrottleMs() {
    const raw = process.env.CAPTIONS_INTERIM_THROTTLE_MS;
    if (raw === undefined || String(raw).trim() === '') return 250;
    const n = parseInt(String(raw).trim(), 10);
    return Number.isFinite(n) && n >= 0 && n <= 2000 ? n : 250;
}

/** 字幕ログの保持日数（既定 30 日）。 */
export function getCaptionsRetentionDays() {
    const raw = process.env.CAPTIONS_RETENTION_DAYS;
    if (raw === undefined || String(raw).trim() === '') return 30;
    const n = parseInt(String(raw).trim(), 10);
    return Number.isFinite(n) && n >= 1 && n <= 3650 ? n : 30;
}

/**
 * GCP Speech の資格情報を解決する。
 * - GOOGLE_APPLICATION_CREDENTIALS（ファイルパス）→ SDK が自動で読むため mode:'adc'
 * - GOOGLE_SPEECH_CREDENTIALS_JSON（インライン JSON）→ mode:'inline'
 * - どちらも無ければ null
 * @returns {{mode:'adc'} | {mode:'inline', credentials:object, projectId?:string} | null}
 */
export function resolveSpeechCredentials() {
    const adcPath = getEnvTrim('GOOGLE_APPLICATION_CREDENTIALS');
    if (adcPath) return { mode: 'adc' };

    const inlineJson = getEnvTrim('GOOGLE_SPEECH_CREDENTIALS_JSON');
    if (inlineJson) {
        try {
            const parsed = JSON.parse(inlineJson);
            return {
                mode: 'inline',
                credentials: parsed,
                projectId: parsed.project_id || undefined,
            };
        } catch (e) {
            console.error('[captions] GOOGLE_SPEECH_CREDENTIALS_JSON is not valid JSON:', e.message);
            return null;
        }
    }
    return null;
}

/**
 * 実行時に字幕機能が使えるか（有効化フラグ＋プロバイダ準備）。
 * mock プロバイダは資格情報不要。google は資格情報必須。
 * @returns {boolean}
 */
export function isCaptionsRuntimeReady() {
    if (!CAPTIONS_ENABLED) return false;
    if (CAPTIONS_STT_PROVIDER === 'mock') return true;
    return resolveSpeechCredentials() != null;
}
