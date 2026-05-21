// addons/matsuyama-flights/client/flight-board-filter.js — 発着ボード表示フィルタ
import { t } from '/js/metaverse-i18n.js';

/** @typedef {'all'|'domestic'|'international'} FlightBoardFilter */

export const FLIGHT_BOARD_FILTERS = {
    ALL: 'all',
    DOMESTIC: 'domestic',
    INTERNATIONAL: 'international',
};

/** 国際線とみなす行き先・出発地（松山空港公式の絞り込みと同等） */
const INTERNATIONAL_PLACE_HINTS = ['ソウル', '台北', '釜山'];

/** 国際線航空会社（単独便） */
const INTERNATIONAL_AIRLINE_CODES = new Set(['EVA', 'ABL']);

/**
 * 表示フィルタを正規化
 * @param {unknown} raw
 * @returns {FlightBoardFilter}
 */
export function normalizeBoardFilter(raw) {
    const s = String(raw || 'all').trim().toLowerCase();
    if (s === 'domestic') return 'domestic';
    if (s === 'international' || s === 'intl') return 'international';
    return 'all';
}

/**
 * 便が国際線か
 * @param {object} row
 * @returns {boolean}
 */
export function isInternationalFlight(row) {
    const place = String(
        row.destination || row.origin || row.counterpart || ''
    ).trim();
    if (INTERNATIONAL_PLACE_HINTS.some((h) => place.includes(h))) {
        return true;
    }

    const airlineRaw = String(row.airline || '');
    const codes = airlineRaw.split('/').map((p) => p.trim().toUpperCase()).filter(Boolean);
    if (codes.length === 0) return false;
    if (codes.every((c) => INTERNATIONAL_AIRLINE_CODES.has(c))) return true;
    if (codes.some((c) => INTERNATIONAL_AIRLINE_CODES.has(c)) && codes.length === 1) {
        return true;
    }
    return false;
}

/**
 * フィルタラベル（エディタ一覧用）
 * @param {FlightBoardFilter} filter
 * @returns {string}
 */
export function boardFilterEditorLabel(filter) {
    const f = normalizeBoardFilter(filter);
    if (f === 'domestic') return t('flightBoard.editorDomestic');
    if (f === 'international') return t('flightBoard.editorInternational');
    return t('flightBoard.editorAll');
}

/**
 * キャンバス見出し用サブタイトル
 * @param {FlightBoardFilter} filter
 * @returns {string}
 */
export function boardFilterCanvasTag(filter) {
    const f = normalizeBoardFilter(filter);
    if (f === 'domestic') return t('flightBoard.filterDomestic');
    if (f === 'international') return t('flightBoard.filterInternational');
    return '';
}

/**
 * ワールド編集プレビュー用メッセージ
 * @param {FlightBoardFilter} filter
 * @param {boolean} [afterSave]
 * @returns {string}
 */
export function flightBoardEditorPreviewMessage(filter, afterSave = true) {
    const tag = boardFilterCanvasTag(filter);
    if (afterSave) {
        return tag ? t('flightBoard.previewWithTag', { tag }) : t('flightBoard.previewDefault');
    }
    return tag ? t('flightBoard.previewTagOnly', { tag }) : t('flightBoard.previewOps');
}

/**
 * board API データをフィルタ
 * @param {object|null} data
 * @param {FlightBoardFilter} filter
 * @returns {object|null}
 */
export function filterBoardData(data, filter) {
    if (!data || !data.ok) return data;
    const f = normalizeBoardFilter(filter);
    if (f === 'all') return data;

    const pred =
        f === 'international'
            ? isInternationalFlight
            : (row) => !isInternationalFlight(row);

    return {
        ...data,
        departures: (data.departures || []).filter(pred),
        arrivals: (data.arrivals || []).filter(pred),
    };
}
