// addons/matsuyama-flights/lib/layout-signature.js — 松山空港 timetable.html レイアウト検証
import * as cheerio from 'cheerio';
import { createHash } from 'node:crypto';

/** 参照 HTML（timetable.html）から得た構造署名（行数は含めない） */
export const EXPECTED_LAYOUT_SIGNATURE =
    'depLabels:定刻|行き先|航空会社|便名|arrLabels:定刻|出発地|航空会社|便名|line:変更|備考|depTd:6|arrTd:6';

/**
 * cheerio ルートから1行目の td ラベル（span 先頭テキスト）を取得
 * @param {cheerio.CheerioAPI} $
 * @param {cheerio.Cheerio<cheerio.Element>} row
 * @returns {string[]}
 */
function rowTdLabels($, row) {
    /** @type {string[]} */
    const labels = [];
    row.find('> td').each((_i, td) => {
        const label = $(td).children('span').first().text().trim();
        if (label) labels.push(label);
    });
    return labels;
}

/**
 * 構造署名文字列を生成（便数は含めない）
 * @param {cheerio.CheerioAPI} $
 * @returns {string}
 */
export function computeLayoutSignature($) {
    const firstDep = $('.flightListBox table.departure tbody tr').first();
    const firstArr = $('.flightListBox table.arrival tbody tr').first();
    const depLabels = rowTdLabels($, firstDep).filter((l) => l !== '変更' && l !== '備考');
    const arrLabels = rowTdLabels($, firstArr).filter((l) => l !== '変更' && l !== '備考');

    const line = firstDep.find('td.line').first();
    const lineSpans = [];
    line.find('span').each((_i, el) => {
        const t = $(el).text().trim();
        if (t === '変更' || t === '備考') lineSpans.push(t);
    });

    const depTd = firstDep.find('> td').length;
    const arrTd = firstArr.find('> td').length;

    return [
        `depLabels:${depLabels.join('|')}`,
        `arrLabels:${arrLabels.join('|')}`,
        `line:${lineSpans.join('|')}`,
        `depTd:${depTd}`,
        `arrTd:${arrTd}`,
    ].join('|');
}

/**
 * 署名の SHA256（ログ用）
 * @param {string} signature
 * @returns {string}
 */
export function hashLayoutSignature(signature) {
    return createHash('sha256').update(signature, 'utf8').digest('hex').slice(0, 16);
}

/**
 * 松山空港公式 timetable HTML のレイアウトを検証
 * @param {string} html
 * @returns {{ valid: boolean, reasons: string[], signature: string, signatureHash: string }}
 */
export function validateAirportTimetableLayout(html) {
    const $ = cheerio.load(html);
    /** @type {string[]} */
    const reasons = [];

    const depRows = $('.flightListBox table.departure tbody tr');
    const arrRows = $('.flightListBox table.arrival tbody tr');

    if (depRows.length < 1) {
        reasons.push('出発テーブル .flightListBox table.departure tbody tr が0件');
    }
    if (arrRows.length < 1) {
        reasons.push('到着テーブル .flightListBox table.arrival tbody tr が0件');
    }

    const firstDep = depRows.first();
    const firstArr = arrRows.first();

    if (firstDep.length) {
        const depLabels = rowTdLabels($, firstDep);
        for (const need of ['定刻', '行き先', '航空会社', '便名']) {
            if (!depLabels.includes(need)) {
                reasons.push(`出発行にラベル「${need}」がありません`);
            }
        }
        const line = firstDep.find('td.line').first();
        if (!line.length) {
            reasons.push('出発行に td.line がありません');
        } else {
            const lineText = line.text();
            if (!lineText.includes('変更')) reasons.push('状況列に「変更」がありません');
            if (!lineText.includes('備考')) reasons.push('状況列に「備考」がありません');
        }
    }

    if (firstArr.length) {
        const arrLabels = rowTdLabels($, firstArr);
        if (!arrLabels.includes('出発地')) {
            reasons.push('到着行にラベル「出発地」がありません');
        }
    }

    const signature = computeLayoutSignature($);
    const signatureHash = hashLayoutSignature(signature);

    if (reasons.length === 0 && signature !== EXPECTED_LAYOUT_SIGNATURE) {
        reasons.push(
            `構造署名が一致しません（expected=${EXPECTED_LAYOUT_SIGNATURE}, got=${signature}）`
        );
    }

    return {
        valid: reasons.length === 0,
        reasons,
        signature,
        signatureHash,
    };
}
