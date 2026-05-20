// addons/matsuyama-flights/lib/airport-timetable-client.js — 松山空港公式運行状況 HTML
import * as cheerio from 'cheerio';
import { jstTodayYmd, parseMinutes } from './flight-date-jst.js';
import { orderFlightsForBoard } from './odpt-client.js';
import { validateAirportTimetableLayout } from './layout-signature.js';

export const DEFAULT_TIMETABLE_URL =
    'https://www.matsuyama-airport.co.jp/flight/timetable.html';

const FETCH_HEADERS = {
    Accept: 'text/html,application/xhtml+xml',
    'Accept-Language': 'ja,en;q=0.9',
    'User-Agent': 'metaverse-matsuyama-flights/2.0',
};

/**
 * 時刻文字列を HH:mm に正規化
 * @param {string} raw
 * @returns {string}
 */
function normalizeHm(raw) {
    const s = String(raw || '').trim();
    const m = s.match(/(\d{1,2}):(\d{2})/);
    if (!m) return '—';
    return `${m[1].padStart(2, '0')}:${m[2]}`;
}

/**
 * 定刻セル HTML から旧・新時刻を解析
 * @param {string} html
 * @returns {{ scheduledTime: string, displayTime: string, timeChanged: boolean }}
 */
function parseScheduleCellHtml(html) {
    const s = String(html || '');
    const struck = s.match(/<s[^>]*>([^<]*)<\/s>\s*([^<\s][^<]*)/i);
    if (struck) {
        const scheduledTime = normalizeHm(struck[1]);
        const displayTime = normalizeHm(struck[2]);
        if (scheduledTime !== '—' && displayTime !== '—' && scheduledTime !== displayTime) {
            return { scheduledTime, displayTime, timeChanged: true };
        }
    }
    const plain = s.replace(/<[^>]+>/g, '').trim();
    const afterLabel = plain.replace(/^定刻/, '').trim();
    const t = normalizeHm(afterLabel);
    return { scheduledTime: t, displayTime: t, timeChanged: false };
}

/**
 * td.line から変更・備考を取得
 * @param {cheerio.CheerioAPI} $
 * @param {cheerio.Cheerio<cheerio.Element>} lineTd
 * @returns {{ changeNote: string|null, remark: string|null }}
 */
function parseLineCell($, lineTd) {
    let changeNote = null;
    let remark = null;
    const html = lineTd.html() || '';
    const parts = html.split(/<br\s*\/?>/i);
    for (const part of parts) {
        const text = cheerio.load(`<div>${part}</div>`)('div').text().replace(/\s+/g, ' ').trim();
        if (text.startsWith('変更')) {
            const note = text.replace(/^変更\s*/, '').trim();
            if (note && note !== '-') changeNote = note;
        }
        if (text.startsWith('備考')) {
            const note = text.replace(/^備考\s*/, '').trim();
            if (note) remark = note;
        }
    }
    return { changeNote, remark };
}

/**
 * 行内の経路検索リンクから運行日を推定
 * @param {cheerio.CheerioAPI} $
 * @param {cheerio.Cheerio<cheerio.Element>} row
 * @returns {string|null}
 */
function parseServiceDateFromRow($, row) {
    const href = row.find('a#link, a[href*="boardingDate"], a[href*="std="]').first().attr('href') || '';
    const boarding = href.match(/boardingDate=(\d{8})/);
    if (boarding) {
        const d = boarding[1];
        return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
    }
    const std = href.match(/std=(\d{8})/);
    if (std) {
        const d = std[1];
        return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
    }
    return null;
}

/**
 * 航空会社セルからコード一覧
 * @param {cheerio.CheerioAPI} $
 * @param {cheerio.Cheerio<cheerio.Element>} td
 * @returns {string}
 */
function parseAirlines($, td) {
    /** @type {string[]} */
    const codes = [];
    td.find('img[src*="/img/logo/"]').each((_i, img) => {
        const src = $(img).attr('src') || '';
        const m = src.match(/\/img\/logo\/([^./]+)\.png/i);
        if (m) codes.push(m[1].toUpperCase());
    });
    return codes.length ? codes.join('/') : '—';
}

/**
 * ラベル付き td の値テキスト
 * @param {cheerio.CheerioAPI} $
 * @param {cheerio.Cheerio<cheerio.Element>} row
 * @param {string} label
 * @returns {string}
 */
function cellValueByLabel($, row, label) {
    let value = '—';
    row.find('> td').each((_i, td) => {
        const spanLabel = $(td).children('span').first().text().trim();
        if (spanLabel === label) {
            const clone = $(td).clone();
            clone.children('span').first().remove();
            value = clone.text().replace(/\s+/g, ' ').trim() || '—';
        }
    });
    return value;
}

/**
 * テーブル1行を正規化
 * @param {cheerio.CheerioAPI} $
 * @param {cheerio.Cheerio<cheerio.Element>} row
 * @param {'departure'|'arrival'} direction
 * @returns {object|null}
 */
function normalizeRow($, row, direction) {
    const scheduleTd = row.find('> td').first();
    const { scheduledTime, displayTime, timeChanged: strikeChanged } = parseScheduleCellHtml(
        scheduleTd.html() || ''
    );

    const lineTd = row.find('td.line').first();
    const { changeNote, remark } = parseLineCell($, lineTd);
    const timeChanged = strikeChanged || Boolean(changeNote);

    const placeLabel = direction === 'departure' ? '行き先' : '出発地';
    const place = cellValueByLabel($, row, placeLabel);
    const flightNumber = cellValueByLabel($, row, '便名');
    const airline = parseAirlines($, row.find('> td').eq(2));

    const serviceDate = parseServiceDateFromRow($, row) || jstTodayYmd();
    const status = remark || changeNote || '—';
    const sortMin = parseMinutes(displayTime) ?? 0;
    const completed = Boolean(remark && /済/.test(remark));

    return {
        airline,
        flightNumber,
        time: displayTime,
        scheduledTime,
        displayTime,
        timeChanged,
        changeNote,
        remark,
        status,
        counterpart: place,
        destination: direction === 'departure' ? place : undefined,
        origin: direction === 'arrival' ? place : undefined,
        direction,
        completed,
        sortMinutes: sortMin,
        serviceDate,
    };
}

/**
 * テーブルをパース
 * @param {cheerio.CheerioAPI} $
 * @param {'departure'|'arrival'} direction
 * @returns {object[]}
 */
function parseTable($, direction) {
    const sel = direction === 'departure' ? 'table.departure' : 'table.arrival';
    /** @type {object[]} */
    const out = [];
    $(`.flightListBox ${sel} tbody tr`).each((_i, tr) => {
        const row = normalizeRow($, $(tr), direction);
        if (row) out.push(row);
    });
    return out;
}

/**
 * HTML から発着をパース
 * @param {string} html
 * @returns {{ departures: object[], arrivals: object[] }}
 */
export function parseAirportTimetable(html) {
    const $ = cheerio.load(html);
    const departures = orderFlightsForBoard(parseTable($, 'departure'));
    const arrivals = orderFlightsForBoard(parseTable($, 'arrival'));
    return { departures, arrivals };
}

/**
 * 公式ページ HTML を取得
 * @param {string} url
 * @returns {Promise<string>}
 */
export async function fetchAirportTimetableHtml(url = DEFAULT_TIMETABLE_URL) {
    const res = await fetch(url, {
        headers: FETCH_HEADERS,
        signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Airport timetable HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    return res.text();
}

/**
 * 取得 → レイアウト検証 → パース
 * @param {object} [opts]
 * @param {string} [opts.url]
 * @returns {Promise<{
 *   departures: object[],
 *   arrivals: object[],
 *   layoutValid: boolean,
 *   layoutReasons: string[],
 *   layoutSignature: string,
 * }>}
 */
export async function fetchMatsuyamaAirportBoard(opts = {}) {
    const url = String(opts.url || DEFAULT_TIMETABLE_URL).trim() || DEFAULT_TIMETABLE_URL;
    const html = await fetchAirportTimetableHtml(url);
    const layout = validateAirportTimetableLayout(html);

    if (!layout.valid) {
        return {
            departures: [],
            arrivals: [],
            layoutValid: false,
            layoutReasons: layout.reasons,
            layoutSignature: layout.signature,
        };
    }

    const { departures, arrivals } = parseAirportTimetable(html);
    const hasFlights = departures.length > 0 || arrivals.length > 0;

    if (!hasFlights) {
        return {
            departures: [],
            arrivals: [],
            layoutValid: false,
            layoutReasons: ['パース結果が0件'],
            layoutSignature: layout.signature,
        };
    }

    return {
        departures,
        arrivals,
        layoutValid: true,
        layoutReasons: [],
        layoutSignature: layout.signature,
    };
}
