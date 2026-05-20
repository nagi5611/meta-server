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
 * ISO / odpt 時刻文字列から HH:mm
 * @param {unknown} raw
 * @returns {string}
 */
export function formatTimeHm(raw) {
    if (raw == null || raw === '') return '—';
    const s = String(raw);
    const iso = s.match(/T(\d{2}):(\d{2})/);
    if (iso) return `${iso[1]}:${iso[2]}`;
    const hm = s.match(/^(\d{1,2}):(\d{2})/);
    if (hm) return `${hm[1].padStart(2, '0')}:${hm[2]}`;
    return s.length > 8 ? s.slice(0, 8) : s;
}

/**
 * 定刻と変更後（estimated / delay）から表示用時刻を決める
 * @param {unknown} scheduledRaw
 * @param {unknown} estimatedRaw
 * @param {unknown} [delayRaw] odpt:delay（分）
 * @returns {{ scheduledTime: string, displayTime: string, timeChanged: boolean }}
 */
export function resolveFlightDisplayTimes(scheduledRaw, estimatedRaw, delayRaw) {
    const scheduledTime = formatTimeHm(scheduledRaw);
    const estimatedTime =
        estimatedRaw != null && String(estimatedRaw).trim() !== ''
            ? formatTimeHm(estimatedRaw)
            : null;
    if (
        estimatedTime
        && estimatedTime !== '—'
        && estimatedTime !== scheduledTime
    ) {
        return { scheduledTime, displayTime: estimatedTime, timeChanged: true };
    }

    const delayMin = Number(delayRaw);
    if (Number.isFinite(delayMin) && delayMin > 0 && scheduledTime !== '—') {
        const base = parseMinutes(scheduledTime);
        if (base != null) {
            const total = base + delayMin;
            const h = Math.floor(total / 60) % 24;
            const m = total % 60;
            const displayTime = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
            if (displayTime !== scheduledTime) {
                return { scheduledTime, displayTime, timeChanged: true };
            }
        }
    }

    return { scheduledTime, displayTime: scheduledTime, timeChanged: false };
}

/**
 * 複数の生時刻から運行日を得る（最初に取れた日付）
 * @param {...unknown} raws
 * @returns {string|null}
 */
export function firstServiceDateJst(...raws) {
    for (const raw of raws) {
        const d = parseServiceDateJst(raw);
        if (d) return d;
    }
    return null;
}

/**
 * 便が JST 当日の運行か
 * @param {string|null} serviceDate YYYY-MM-DD
 * @param {string} scheduledTime HH:mm（定刻）
 * @param {number} nowMin
 * @returns {boolean}
 */
export function isFlightServiceTodayJst(serviceDate, scheduledTime, nowMin) {
    const today = jstTodayYmd();
    if (serviceDate) return serviceDate === today;

    const rawSched = parseMinutes(scheduledTime);
    if (rawSched == null) return false;
    // 午前6時前: 12:00以降の時刻は前日残データとみなして除外
    if (nowMin < 360 && rawSched >= 720) return false;
    return true;
}
