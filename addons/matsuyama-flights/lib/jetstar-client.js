// addons/matsuyama-flights/lib/jetstar-client.js — Jetstar フライトステータス API（MYJ 発）

import {
    firstServiceDateJst,
    formatTimeHm,
    isFlightServiceTodayJst,
    jetstarDateParamJst,
    nowMinutesJst,
    parseMinutes,
    resolveFlightDisplayTimes,
} from './flight-date-jst.js';

const JETSTAR_STATUS_URL = 'https://digitalapi.jetstar.com/v1/flight-status';

export { jetstarDateParamJst };

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

    const { scheduledTime, displayTime, timeChanged } = resolveFlightDisplayTimes(
        flight.scheduledDepartureDateTime,
        flight.estimatedDepartureDateTime
    );
    const actualTime =
        flight.actualDepartureDateTime != null && flight.actualDepartureDateTime !== ''
            ? (flight.actualDepartureDateTimeInfo?.timeString
                || formatTimeHm(flight.actualDepartureDateTime))
            : null;

    const serviceDate = firstServiceDateJst(
        flight.estimatedDepartureDateTime,
        flight.scheduledDepartureDateTime,
        flight.actualDepartureDateTime
    );

    const status = formatJetstarStatus(flight.statusInfo);
    const nowMin = nowMinutesJst();

    if (!isFlightServiceTodayJst(serviceDate, scheduledTime, nowMin)) {
        return null;
    }

    const hasActual = actualTime != null && actualTime !== '—';
    const completed = hasActual || /欠航/.test(status);
    const sortMin = parseMinutes(displayTime) ?? parseMinutes(scheduledTime) ?? 0;

    return {
        airline,
        flightNumber,
        time: displayTime,
        scheduledTime,
        displayTime,
        timeChanged,
        actualTime,
        serviceDate,
        counterpart: destination,
        destination,
        status,
        direction: 'departure',
        completed,
        sortMinutes: sortMin,
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
