// addons/matsuyama-flights/lib/odpt-client.js — ODPT 航空発着 API クライアント

const ODPT_API_BASE = 'https://api.odpt.org/api/v4';

/** @type {{ code: string, filters: string[] }[]} */
const AIRLINE_OPERATORS = [
    {
        code: 'JAL',
        filters: ['odpt.Airline:JAL', 'odpt.Operator:JAL', 'odpt:Operator:JAL'],
    },
    {
        code: 'ANA',
        filters: ['odpt.Airline:ANA', 'odpt.Operator:ANA', 'odpt:Operator:ANA'],
    },
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
        signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`ODPT ${endpoint} HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    const data = await res.json();
    return Array.isArray(data) ? data : [];
}

/**
 * 文字列が対象空港（IATA）を指すか
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
 * 空港参照が対象空港か（ID 完全一致または IATA/名称ヒューリスティック）
 * @param {unknown} ref
 * @param {string|null} airportId
 * @param {string} airportIata
 * @returns {boolean}
 */
function isAirportMatch(ref, airportId, airportIata) {
    const s = String(ref || '');
    if (!s) return false;
    if (airportId && s === airportId) return true;
    return matchesAirportRef(s, airportIata);
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
 * HH:mm を 0–1439 分に変換（失敗時は null）
 * @param {string} hhmm
 * @returns {number|null}
 */
function parseMinutes(hhmm) {
    const m = String(hhmm || '').match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return null;
    const h = Number(m[1]);
    const min = Number(m[2]);
    if (!Number.isFinite(h) || !Number.isFinite(min)) return null;
    return h * 60 + min;
}

/**
 * 現在時刻（日本）の分
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
 * 表示時刻を「今日」のタイムライン上の分に（深夜跨ぎ補正）
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
    if (/depart|出発/i.test(s)) return '出発済み';
    if (/arriv|到着|landing/i.test(s)) return '到着済み';
    if (/on.?time|定刻|予定/i.test(s)) return '定刻';
    const tail = s.split(/[:.]/).pop();
    return tail || s;
}

/**
 * 行から出発・到着空港フィールドを取り出す
 * @param {Record<string, unknown>} row
 * @returns {{ dep: string, dest: string, arrivalAt: string }}
 */
function extractAirportFields(row) {
    const dep = row['odpt:departureAirport'] || row['odpt:originAirport'] || '';
    const dest = row['odpt:destinationAirport'] || '';
    const arrivalAt =
        row['odpt:destinationAirport']
        || row['odpt:arrivalAirport']
        || row['odpt:airport']
        || dest;
    return { dep: String(dep), dest: String(dest), arrivalAt: String(arrivalAt) };
}

/**
 * ODPT フライト行を正規化（対象空港の発着のみ）
 * @param {Record<string, unknown>} row
 * @param {'departure'|'arrival'} direction
 * @param {string|null} airportId
 * @param {string} airportIata
 * @param {Map<string, string>} airportNames
 * @param {string} [defaultAirlineCode]
 * @returns {object|null}
 */
function normalizeFlightRow(row, direction, airportId, airportIata, airportNames, defaultAirlineCode) {
    const { dep, dest, arrivalAt } = extractAirportFields(row);

    if (direction === 'departure') {
        if (!isAirportMatch(dep, airportId, airportIata)) return null;
    } else {
        if (!isAirportMatch(arrivalAt, airportId, airportIata) && !isAirportMatch(dest, airportId, airportIata)) {
            return null;
        }
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

    const counterpart = direction === 'departure' ? dest || arrivalAt : dep;
    const counterpartLabel = airportDisplay(counterpart, airportNames);

    let airline = airlineLabel(row['odpt:airline'] || row['odpt:operator']);
    if (airline === '—' && defaultAirlineCode) airline = defaultAirlineCode;

    const scheduledTime = formatTime(scheduled);
    const actualTime = actual != null && actual !== '' ? formatTime(actual) : null;
    const status = formatStatus(row['odpt:flightStatus'], row['odpt:delay']);
    const nowMin = nowMinutesJst();
    const schedMin = timelineMinutes(scheduledTime, nowMin) ?? 0;

    const hasActual = actual != null && String(actual).trim() !== '';
    const completed =
        hasActual
        || status === '出発済み'
        || status === '到着済み'
        || /欠航/.test(status)
        || (schedMin != null && schedMin < nowMin - 20 && status !== '定刻');

    return {
        airline,
        flightNumber: String(row['odpt:flightNumber'] || row['odpt:flightNumberSuffix'] || '—'),
        time: scheduledTime,
        scheduledTime,
        actualTime,
        counterpart: counterpartLabel,
        destination: direction === 'departure' ? counterpartLabel : undefined,
        origin: direction === 'arrival' ? counterpartLabel : undefined,
        status,
        direction,
        completed,
        sortMinutes: schedMin,
    };
}

/**
 * 案内板表示順: 定刻（scheduledTime）の昇順で当日分を一覧表示
 * @param {object[]} flights
 * @returns {object[]}
 */
export function orderFlightsForBoard(flights) {
    return [...flights].sort((a, b) => {
        const sa = a.sortMinutes ?? 0;
        const sb = b.sortMinutes ?? 0;
        if (sa !== sb) return sa - sb;
        return String(a.flightNumber || '').localeCompare(String(b.flightNumber || ''));
    });
}

/**
 * 便の重複キー
 * @param {object} f
 * @returns {string}
 */
function flightDedupeKey(f) {
    return `${f.direction}|${f.airline}|${f.flightNumber}|${f.time}|${f.counterpart}`;
}

/**
 * 配列に正規化済み便をマージ（重複除去）
 * @param {object[]} target
 * @param {object[]} incoming
 */
export function mergeFlights(target, incoming) {
    const seen = new Set(target.map(flightDedupeKey));
    for (const f of incoming) {
        const k = flightDedupeKey(f);
        if (seen.has(k)) continue;
        seen.add(k);
        target.push(f);
    }
}

/**
 * 生データ配列を正規化してマージ
 * @param {object[]} target
 * @param {unknown[]} rows
 * @param {'departure'|'arrival'} direction
 * @param {string|null} airportId
 * @param {string} airportIata
 * @param {Map<string, string>} airportNames
 * @param {string} [defaultAirlineCode]
 */
function mergeNormalizedRows(target, rows, direction, airportId, airportIata, airportNames, defaultAirlineCode) {
    const batch = [];
    for (const row of rows) {
        if (!row || typeof row !== 'object') continue;
        const n = normalizeFlightRow(
            /** @type {Record<string, unknown>} */ (row),
            direction,
            airportId,
            airportIata,
            airportNames,
            defaultAirlineCode
        );
        if (n) batch.push(n);
    }
    mergeFlights(target, batch);
}

/**
 * 指定エンドポイントをパラメータなしで全件取得し、対象空港でフィルタ
 * @param {object} opts
 * @param {string} opts.endpoint
 * @param {'departure'|'arrival'} opts.direction
 * @param {string} opts.consumerKey
 * @param {string|null} opts.airportId
 * @param {string} opts.airportIata
 * @param {Map<string, string>} opts.airportNames
 * @returns {Promise<object[]>}
 */
async function fetchAllFiltered(opts) {
    const { endpoint, direction, consumerKey, airportId, airportIata, airportNames } = opts;
    const rows = await odptGet(endpoint, consumerKey);
    const out = [];
    mergeNormalizedRows(out, rows, direction, airportId, airportIata, airportNames);
    return out;
}

/**
 * 航空会社別フィルタを複数パターン試す（空港クエリは付けない）
 * @param {object} opts
 * @param {string} opts.endpoint
 * @param {'departure'|'arrival'} opts.direction
 * @param {string} opts.consumerKey
 * @param {string|null} opts.airportId
 * @param {string} opts.airportIata
 * @param {Map<string, string>} opts.airportNames
 * @param {object[]} opts.target
 */
async function fetchByAirlineOperators(opts) {
    const { endpoint, direction, consumerKey, airportId, airportIata, airportNames, target } = opts;

    for (const { code, filters } of AIRLINE_OPERATORS) {
        let gotAny = false;
        for (const airlineFilter of filters) {
            try {
                const rows = await odptGet(endpoint, consumerKey, { 'odpt:airline': airlineFilter });
                if (rows.length > 0) {
                    mergeNormalizedRows(target, rows, direction, airportId, airportIata, airportNames, code);
                    gotAny = true;
                }
            } catch {
                /* try next filter */
            }
        }
        if (!gotAny) {
            try {
                const rows = await odptGet(endpoint, consumerKey, { 'odpt:operator': `odpt.Operator:${code}` });
                mergeNormalizedRows(target, rows, direction, airportId, airportIata, airportNames, code);
            } catch {
                /* ignore */
            }
        }
    }
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
    const iata = String(airportIata || 'MYJ').trim().toUpperCase() || 'MYJ';
    let airportId = knownAirportId || null;
    if (!airportId) {
        airportId = await resolveAirportId(consumerKey, iata);
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

    // 到着: クエリ絞り込みなしで全件取得 → 松山着のみクライアント側フィルタ（APIの空港パラメータ不一致を避ける）
    try {
        const allArrivals = await fetchAllFiltered({
            endpoint: 'odpt:FlightInformationArrival',
            direction: 'arrival',
            consumerKey,
            airportId,
            airportIata: iata,
            airportNames,
        });
        mergeFlights(arrivals, allArrivals);
    } catch (e) {
        console.warn('[matsuyama-flights] arrival full fetch:', e.message);
    }

    await fetchByAirlineOperators({
        endpoint: 'odpt:FlightInformationArrival',
        direction: 'arrival',
        consumerKey,
        airportId,
        airportIata: iata,
        airportNames,
        target: arrivals,
    });

    // 出発: 全件 + 航空会社別をマージ
    try {
        const allDepartures = await fetchAllFiltered({
            endpoint: 'odpt:FlightInformationDeparture',
            direction: 'departure',
            consumerKey,
            airportId,
            airportIata: iata,
            airportNames,
        });
        mergeFlights(departures, allDepartures);
    } catch (e) {
        console.warn('[matsuyama-flights] departure full fetch:', e.message);
    }

    await fetchByAirlineOperators({
        endpoint: 'odpt:FlightInformationDeparture',
        direction: 'departure',
        consumerKey,
        airportId,
        airportIata: iata,
        airportNames,
        target: departures,
    });

    return {
        departures: orderFlightsForBoard(departures),
        arrivals: orderFlightsForBoard(arrivals),
        airportId,
    };
}
