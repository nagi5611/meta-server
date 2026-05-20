// addons/matsuyama-flights/lib/jetstar-client.js — Jetstar フライトステータス API（MYJ 発）

const JETSTAR_STATUS_URL = 'https://digitalapi.jetstar.com/v1/flight-status';

/** @type {Record<string, string>} */
const STATUS_LABELS = {
    arrived: '到着済み',
    departed: '出発済み',
    cancelled: '欠航',
    canceled: '欠航',
    delayed: '遅延',
    boarding: '搭乗中',
    scheduled: '定刻',
    ontime: '定刻',
    'on time': '定刻',
};

/**
 * JST の当日を Jetstar API の date クエリ形式（YYYY/MM/DD）にする
 * @returns {string}
 */
export function jetstarDateParamJst() {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Tokyo',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).formatToParts(new Date());
    const y = parts.find((p) => p.type === 'year')?.value ?? '1970';
    const m = parts.find((p) => p.type === 'month')?.value ?? '01';
    const d = parts.find((p) => p.type === 'day')?.value ?? '01';
    return `${y}/${m}/${d}`;
}

/**
 * ISO 風文字列から HH:mm
 * @param {unknown} raw
 * @returns {string}
 */
function formatTime(raw) {
    if (raw == null || raw === '') return '—';
    const s = String(raw);
    const iso = s.match(/T(\d{2}):(\d{2})/);
    if (iso) return `${iso[1]}:${iso[2]}`;
    const hm = s.match(/^(\d{1,2}):(\d{2})/);
    if (hm) return `${hm[1].padStart(2, '0')}:${hm[2]}`;
    return s.length > 8 ? s.slice(0, 8) : s;
}

/**
 * HH:mm を分に
 * @param {string} hhmm
 * @returns {number|null}
 */
function parseMinutes(hhmm) {
    const m = String(hhmm || '').match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return null;
    return Number(m[1]) * 60 + Number(m[2]);
}

/**
 * 現在 JST の分
 * @returns {number}
 */
function nowMinutesJst() {
    const parts = new Intl.DateTimeFormat('ja-JP', {
        timeZone: 'Asia/Tokyo',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
    }).formatToParts(new Date());
    const h = Number(parts.find((p) => p.type === 'hour')?.value ?? 0);
    const min = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
    return h * 60 + min;
}

/**
 * @param {string} hhmm
 * @param {number} nowMin
 * @returns {number|null}
 */
function timelineMinutes(hhmm, nowMin) {
    const min = parseMinutes(hhmm);
    if (min == null) return null;
    if (min > nowMin + 12 * 60) return min - 24 * 60;
    return min;
}

/**
 * Jetstar statusInfo を表示用に
 * @param {object} statusInfo
 * @returns {string}
 */
function formatJetstarStatus(statusInfo) {
    const delayMin = Number(statusInfo?.delayMinutes ?? 0);
    const delayHr = Number(statusInfo?.delayHours ?? 0);
    const totalDelay = delayHr * 60 + delayMin;
    if (Number.isFinite(totalDelay) && totalDelay > 0) return `遅延 ${totalDelay}分`;

    const key = String(statusInfo?.status || '').trim().toLowerCase();
    if (STATUS_LABELS[key]) return STATUS_LABELS[key];
    if (/delay/i.test(key)) return '遅延';
    if (/cancel/i.test(key)) return '欠航';
    return statusInfo?.status ? String(statusInfo.status) : '—';
}

/**
 * レスポンスから便オブジェクトを列挙する
 * @param {object} body
 * @returns {object[]}
 */
function collectFlights(body) {
    /** @type {object[]} */
    const out = [];
    for (const journey of body.journeys || []) {
        for (const segment of journey.segments || []) {
            for (const flight of segment.flights || []) {
                if (flight && typeof flight === 'object') out.push(flight);
            }
        }
    }
    return out;
}

/**
 * Jetstar 1便を ODPT ボード形式に正規化（出発のみ）
 * @param {object} flight
 * @param {string} originIata
 * @returns {object|null}
 */
function normalizeJetstarDeparture(flight, originIata) {
    const origin = String(flight.originCode || '').trim().toUpperCase();
    if (origin && origin !== originIata.toUpperCase()) return null;

    const num = String(flight.flightNumber || '').trim();
    const op = String(flight.operator || 'GK').trim();
    const flightNumber = num ? `${op}${num}` : '—';
    const airline = 'JJP';
    const destination = String(flight.destination || flight.destinationCode || '—').trim() || '—';

    const scheduledTime =
        flight.scheduledDepartureDateTimeTimeInfo?.timeString
        || formatTime(flight.scheduledDepartureDateTime);
    const actualTime =
        flight.actualDepartureDateTime != null && flight.actualDepartureDateTime !== ''
            ? (flight.actualDepartureDateTimeInfo?.timeString
                || formatTime(flight.actualDepartureDateTime))
            : null;

    const status = formatJetstarStatus(flight.statusInfo);
    const nowMin = nowMinutesJst();
    const schedMin = timelineMinutes(scheduledTime, nowMin) ?? 0;

    const hasActual = actualTime != null && actualTime !== '—';
    const completed =
        hasActual
        || status === '出発済み'
        || status === '到着済み'
        || /欠航/.test(status)
        || (schedMin != null && schedMin < nowMin - 20 && status !== '定刻');

    return {
        airline,
        flightNumber,
        time: scheduledTime,
        scheduledTime,
        actualTime,
        counterpart: destination,
        destination,
        status,
        direction: 'departure',
        completed,
        sortMinutes: schedMin,
    };
}

/**
 * Jetstar API から松山発（既定 MYJ→NRT）の出発便を取得する
 * @param {object} [opts]
 * @param {string} [opts.origin] 既定 MYJ
 * @param {string} [opts.destination] 既定 NRT
 * @param {string} [opts.date] YYYY/MM/DD（未指定時は JST 当日）
 * @returns {Promise<object[]>}
 */
export async function fetchJetstarDepartures(opts = {}) {
    const origin = String(opts.origin || 'MYJ').trim().toUpperCase() || 'MYJ';
    const destination = String(opts.destination || 'NRT').trim().toUpperCase() || 'NRT';
    const date = String(opts.date || jetstarDateParamJst()).trim();

    const url = new URL(JETSTAR_STATUS_URL);
    url.searchParams.set('origin', origin);
    url.searchParams.set('destination', destination);
    url.searchParams.set('date', date);

    const res = await fetch(url.toString(), {
        headers: {
            Accept: 'application/json',
            culture: 'ja-JP',
            'Accept-Language': 'ja;q=0.9',
            Origin: 'https://booking.jetstar.com',
            Referer: 'https://booking.jetstar.com/',
            'User-Agent': 'metaverse-matsuyama-flights/1.0',
        },
        signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Jetstar flight-status HTTP ${res.status}: ${text.slice(0, 200)}`);
    }

    const body = await res.json();
    if (body?.errorCode) {
        throw new Error(`Jetstar ${body.errorCode}: ${body.errorMessage || ''}`);
    }

    /** @type {object[]} */
    const departures = [];
    for (const flight of collectFlights(body)) {
        const row = normalizeJetstarDeparture(flight, origin);
        if (row) departures.push(row);
    }
    return departures;
}
