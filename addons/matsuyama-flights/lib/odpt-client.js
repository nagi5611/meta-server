// addons/matsuyama-flights/lib/odpt-client.js — ODPT 航空発着 API クライアント

const ODPT_API_BASE = 'https://api.odpt.org/api/v4';

const AIRLINE_OPERATORS = [
    { code: 'JAL', filter: 'odpt.Operator:JAL' },
    { code: 'ANA', filter: 'odpt.Operator:ANA' },
];

/**
 * ODPT API に GET する
 * @param {string} endpoint 例 odpt:FlightInformationDeparture
 * @param {string} consumerKey
 * @param {Record<string, string>} [extraParams]
 * @returns {Promise<unknown[]>}
 */
async function odptGet(endpoint, consumerKey, extraParams = {}) {
    const url = new URL(`${ODPT_API_BASE}/${endpoint}`);
    url.searchParams.set('acl:consumerKey', consumerKey);
    for (const [k, v] of Object.entries(extraParams)) {
        if (v != null && v !== '') url.searchParams.set(k, v);
    }
    const res = await fetch(url.toString(), {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`ODPT ${endpoint} HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    const data = await res.json();
    return Array.isArray(data) ? data : [];
}

/**
 * 文字列が松山空港（MYJ）を指すか
 * @param {string} idOrTitle
 * @param {string} airportIata
 * @returns {boolean}
 */
function matchesAirportRef(idOrTitle, airportIata) {
    const s = String(idOrTitle || '');
    if (!s) return false;
    const iata = airportIata.toUpperCase();
    if (s.toUpperCase().includes(iata)) return true;
    if (/Matsuyama/i.test(s)) return true;
    if (/松山/.test(s)) return true;
    return false;
}

/**
 * odpt:Airport 一覧から IATA に対応する owl:sameAs を解決する
 * @param {string} consumerKey
 * @param {string} airportIata
 * @returns {Promise<string|null>}
 */
export async function resolveAirportId(consumerKey, airportIata) {
    const airports = await odptGet('odpt:Airport', consumerKey);
    const iata = airportIata.toUpperCase();
    for (const row of airports) {
        const sameAs = row['owl:sameAs'] || row['@id'] || '';
        const title = row['dc:title'] || row['odpt:airportTitle'] || '';
        const titleJa = typeof title === 'object' ? title.ja || title.en : title;
        const code = row['odpt:iataCode'] || row['odpt:airportCode'] || '';
        if (String(code).toUpperCase() === iata) return String(sameAs);
        if (matchesAirportRef(sameAs, iata) || matchesAirportRef(titleJa, iata)) {
            return String(sameAs);
        }
    }
    return null;
}

/**
 * 航空会社 ID を短い表示名に
 * @param {string} airlineRef
 * @returns {string}
 */
function airlineLabel(airlineRef) {
    const s = String(airlineRef || '');
    if (/JAL|JapanAirlines|Japan.?Air/i.test(s)) return 'JAL';
    if (/ANA|AllNippon/i.test(s)) return 'ANA';
    const parts = s.split(/[:.]/);
    return parts[parts.length - 1] || s || '—';
}

/**
 * 空港 ID を表示用に短縮（タイトル優先、なければ末尾）
 * @param {string} airportRef
 * @param {Map<string, string>} airportNames
 * @returns {string}
 */
function airportDisplay(airportRef, airportNames) {
    const key = String(airportRef || '');
    if (airportNames.has(key)) return airportNames.get(key);
    const parts = key.split(/[:.]/);
    return parts[parts.length - 1] || key || '—';
}

/**
 * ISO 時刻または odpt:Time から HH:mm を得る
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
 * 運航状況を表示用に
 * @param {unknown} status
 * @param {unknown} delay
 * @returns {string}
 */
function formatStatus(status, delay) {
    const d = Number(delay);
    if (Number.isFinite(d) && d > 0) return `遅延 ${d}分`;
    const s = String(status || '').trim();
    if (!s) return '—';
    if (/delay|遅延/i.test(s)) return '遅延';
    if (/cancel|欠航/i.test(s)) return '欠航';
    if (/depart|出発/i.test(s)) return '出発';
    if (/arriv|到着|landing/i.test(s)) return '到着';
    if (/on.?time|定刻|予定/i.test(s)) return '定刻';
    const tail = s.split(/[:.]/).pop();
    return tail || s;
}

/**
 * ODPT フライト行を正規化
 * @param {Record<string, unknown>} row
 * @param {'departure'|'arrival'} direction
 * @param {string} airportId
 * @param {Map<string, string>} airportNames
 * @returns {object|null}
 */
function normalizeFlightRow(row, direction, airportId, airportNames) {
    const dep = row['odpt:departureAirport'];
    const dest = row['odpt:destinationAirport'];
    const depStr = String(dep || '');
    const destStr = String(dest || '');

    if (direction === 'departure') {
        if (airportId && depStr !== airportId && !matchesAirportRef(depStr, 'MYJ')) return null;
        if (!airportId && !matchesAirportRef(depStr, 'MYJ')) return null;
    } else {
        if (airportId && destStr !== airportId && !matchesAirportRef(destStr, 'MYJ')) return null;
        if (!airportId && !matchesAirportRef(destStr, 'MYJ')) return null;
    }

    const scheduled =
        row['odpt:scheduledDepartureTime']
        || row['odpt:scheduledArrivalTime']
        || row['odpt:scheduledTime']
        || row['odpt:departureTime']
        || row['odpt:arrivalTime'];
    const actual =
        row['odpt:actualDepartureTime']
        || row['odpt:actualArrivalTime']
        || row['odpt:actualTime'];

    const counterpart = direction === 'departure' ? dest : dep;
    const counterpartLabel = airportDisplay(counterpart, airportNames);

    return {
        airline: airlineLabel(row['odpt:airline'] || row['odpt:operator']),
        flightNumber: String(row['odpt:flightNumber'] || row['odpt:flightNumberSuffix'] || '—'),
        time: formatTime(actual || scheduled),
        scheduledTime: formatTime(scheduled),
        counterpart: counterpartLabel,
        status: formatStatus(row['odpt:flightStatus'], row['odpt:delay']),
        direction,
    };
}

/**
 * 発着情報を取得して松山空港分に絞り込む
 * @param {object} opts
 * @param {string} opts.consumerKey
 * @param {string} opts.airportIata
 * @param {string|null} [opts.airportId]
 * @returns {Promise<{ departures: object[], arrivals: object[], airportId: string|null }>}
 */
export async function fetchMatsuyamaFlights({ consumerKey, airportIata, airportId: knownAirportId }) {
    let airportId = knownAirportId || null;
    if (!airportId) {
        airportId = await resolveAirportId(consumerKey, airportIata);
    }

    /** @type {Map<string, string>} */
    const airportNames = new Map();
    try {
        const airports = await odptGet('odpt:Airport', consumerKey);
        for (const a of airports) {
            const id = a['owl:sameAs'] || a['@id'];
            const title = a['dc:title'] || a['odpt:airportTitle'];
            const label = typeof title === 'object' ? (title.ja || title.en) : title;
            if (id && label) airportNames.set(String(id), String(label));
        }
    } catch {
        /* optional */
    }

    /** @type {object[]} */
    const departures = [];
    /** @type {object[]} */
    const arrivals = [];

    const depParams = airportId ? { 'odpt:departureAirport': airportId } : {};
    const arrParams = airportId ? { 'odpt:destinationAirport': airportId } : {};

    for (const { code, filter } of AIRLINE_OPERATORS) {
        try {
            const depRows = await odptGet('odpt:FlightInformationDeparture', consumerKey, {
                ...depParams,
                'odpt:airline': filter,
            });
            for (const row of depRows) {
                const n = normalizeFlightRow(row, 'departure', airportId, airportNames);
                if (n) {
                    n.airline = n.airline === '—' ? code : n.airline;
                    departures.push(n);
                }
            }
        } catch (e) {
            console.warn(`[matsuyama-flights] departure ${code}:`, e.message);
        }

        try {
            const arrRows = await odptGet('odpt:FlightInformationArrival', consumerKey, {
                ...arrParams,
                'odpt:airline': filter,
            });
            for (const row of arrRows) {
                const n = normalizeFlightRow(row, 'arrival', airportId, airportNames);
                if (n) {
                    n.airline = n.airline === '—' ? code : n.airline;
                    arrivals.push(n);
                }
            }
        } catch (e) {
            console.warn(`[matsuyama-flights] arrival ${code}:`, e.message);
        }
    }

    if (departures.length === 0 && arrivals.length === 0 && !airportId) {
        const allDep = await odptGet('odpt:FlightInformationDeparture', consumerKey);
        const allArr = await odptGet('odpt:FlightInformationArrival', consumerKey);
        for (const row of allDep) {
            const n = normalizeFlightRow(row, 'departure', null, airportNames);
            if (n) departures.push(n);
        }
        for (const row of allArr) {
            const n = normalizeFlightRow(row, 'arrival', null, airportNames);
            if (n) arrivals.push(n);
        }
    }

    const sortByTime = (a, b) => String(a.time).localeCompare(String(b.time));
    departures.sort(sortByTime);
    arrivals.sort(sortByTime);

    return { departures, arrivals, airportId };
}
