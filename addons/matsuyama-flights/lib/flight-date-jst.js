// addons/matsuyama-flights/lib/flight-date-jst.js — JST 基準の運行日判定

/**
 * JST の当日（YYYY-MM-DD）
 * @param {Date} [date]
 * @returns {string}
 */
export function jstTodayYmd(date = new Date()) {
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Tokyo',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).format(date);
}

/**
 * Jetstar API の date クエリ（YYYY/MM/DD）
 * @param {Date} [date]
 * @returns {string}
 */
export function jetstarDateParamJst(date = new Date()) {
    return jstTodayYmd(date).replace(/-/g, '/');
}

/**
 * ISO / 数値日付文字列から運行日（YYYY-MM-DD）を得る
 * @param {unknown} raw
 * @returns {string|null}
 */
export function parseServiceDateJst(raw) {
    if (raw == null || raw === '') return null;
    const s = String(raw).trim();
    const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
    const compact = s.match(/^(\d{4})(\d{2})(\d{2})/);
    if (compact) return `${compact[1]}-${compact[2]}-${compact[3]}`;
    return null;
}

/**
 * HH:mm を分に（0–1439）
 * @param {string} hhmm
 * @returns {number|null}
 */
export function parseMinutes(hhmm) {
    const m = String(hhmm || '').match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return null;
    return Number(m[1]) * 60 + Number(m[2]);
}

/**
 * 現在 JST の分（0–1439）
 * @param {Date} [date]
 * @returns {number}
 */
export function nowMinutesJst(date = new Date()) {
    const parts = new Intl.DateTimeFormat('ja-JP', {
        timeZone: 'Asia/Tokyo',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
    }).formatToParts(date);
    const h = Number(parts.find((p) => p.type === 'hour')?.value ?? 0);
    const min = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
    return h * 60 + min;
}

/**
 * 便が JST 当日の運行か（日付フィールド優先、なければ時刻ヒューリスティック）
 * @param {string|null} serviceDate YYYY-MM-DD
 * @param {string} scheduledTime HH:mm
 * @param {boolean} completed
 * @param {number} nowMin
 * @returns {boolean}
 */
export function isFlightServiceTodayJst(serviceDate, scheduledTime, completed, nowMin) {
    const today = jstTodayYmd();
    if (serviceDate) return serviceDate === today;

    const rawSched = parseMinutes(scheduledTime);
    if (rawSched == null) return false;
    // 日付なしで「完了」かつ定刻が現在より大幅に後 → 前日の便
    if (completed && rawSched > nowMin + 60) return false;
    return true;
}
