// addons/matsuyama-flights/client/flight-board-mesh.js — 発着情報 Canvas テクスチャ板（電光掲示板風・横 5:縦 4）
import * as THREE from 'three';
import {
    boardFilterCanvasTag,
    filterBoardData,
    normalizeBoardFilter,
} from './flight-board-filter.js';

const BOARD_API = '/api/addons/matsuyama-flights/board';
const POLL_MS = 60_000;
const ROW_H = 26;
const STACK_LINE_H = 14;
/** changed あり時の列位置（幅の比率） */
const COL_RATIOS_WITH_CHANGED = [0, 0.24, 0.38, 0.56, 0.72];
/** 当日 changed なし時は便名以降を左へ */
const COL_RATIOS_NO_CHANGED = [0, 0.17, 0.30, 0.44, 0.56];
/** 状況列だけ右へずらす文字数 */
const STATUS_COL_SHIFT_CHARS = 2;

/** テクスチャ・メッシュの縦横比（横 5 : 縦 4） */
export const BOARD_ASPECT_W = 5;
export const BOARD_ASPECT_H = 4;

export const CANVAS_W = 1920;
export const CANVAS_H = 1536;

const LED_FONT = "700 26px ui-monospace, 'Cascadia Mono', 'Consolas', monospace";
const LED_FONT_SM = "600 20px ui-monospace, 'Cascadia Mono', 'Consolas', monospace";
const LED_FONT_TITLE = "800 40px ui-monospace, 'Cascadia Mono', 'Consolas', monospace";
const LED_FONT_HEADER = "700 22px ui-monospace, 'Cascadia Mono', 'Consolas', monospace";

const COLOR_BG = '#020202';
const COLOR_PANEL = '#0a0f06';
const COLOR_BORDER = '#5a4a18';
const COLOR_LED = '#ffcc33';
const COLOR_LED_DIM = '#b8860b';
const COLOR_LED_BRIGHT = '#fff4c8';
const COLOR_LED_HIGHLIGHT = '#ffe566';
const COLOR_ERROR = '#ff6644';
const COLOR_SCANLINE = 'rgba(0, 0, 0, 0.22)';
/** 現在時刻に最も近い便の行背景 */
const COLOR_NOW_NEAR = 'rgba(72, 200, 110, 0.22)';

/**
 * 電光掲示板風の発光テキスト
 * @param {CanvasRenderingContext2D} ctx
 * @param {string} text
 * @param {number} x
 * @param {number} y
 * @param {string} [color]
 * @param {boolean} [glow]
 */
function drawLedText(ctx, text, x, y, color = COLOR_LED, glow = false) {
    ctx.textBaseline = 'alphabetic';
    if (glow) {
        ctx.fillStyle = 'rgba(255, 200, 60, 0.35)';
        ctx.fillText(text, x + 1, y + 1);
    }
    ctx.fillStyle = color;
    ctx.fillText(text, x, y);
}

/**
 * 走査線風オーバーレイ
 * @param {CanvasRenderingContext2D} ctx
 */
function drawScanlines(ctx) {
    for (let y = 0; y < CANVAS_H; y += 3) {
        ctx.fillStyle = COLOR_SCANLINE;
        ctx.fillRect(0, y, CANVAS_W, 1);
    }
}

/**
 * 枠・パネル背景
 * @param {CanvasRenderingContext2D} ctx
 */
function drawBoardFrame(ctx) {
    ctx.fillStyle = COLOR_BG;
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

    ctx.strokeStyle = COLOR_BORDER;
    ctx.lineWidth = 4;
    ctx.strokeRect(6, 6, CANVAS_W - 12, CANVAS_H - 12);

    ctx.strokeStyle = 'rgba(255, 180, 50, 0.25)';
    ctx.lineWidth = 1;
    ctx.strokeRect(14, 14, CANVAS_W - 28, CANVAS_H - 28);
}

/**
 * 現在 JST の分（0–1439）
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
 * 便行の表示時刻を分に
 * @param {object} row
 * @returns {number|null}
 */
function rowMinutes(row) {
    if (Number.isFinite(row.sortMinutes)) return row.sortMinutes;
    const t = String(row.displayTime || row.scheduledTime || row.time || '');
    const m = t.match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return null;
    return Number(m[1]) * 60 + Number(m[2]);
}

/**
 * 現在時刻に最も近い便の行インデックス（24h 環で距離最小）
 * @param {object[]} rows
 * @returns {number}
 */
function findNearestRowIndex(rows) {
    const nowMin = nowMinutesJst();
    let best = -1;
    let bestDist = Infinity;
    for (let i = 0; i < rows.length; i++) {
        const m = rowMinutes(rows[i]);
        if (m == null) continue;
        let d = Math.abs(m - nowMin);
        d = Math.min(d, 1440 - d);
        if (d < bestDist) {
            bestDist = d;
            best = i;
        }
    }
    return best;
}

/**
 * 発着ボード用キャンバスに描画する
 * @param {CanvasRenderingContext2D} ctx
 * @param {object|null} data
 * @param {string} [message]
 * @param {import('./flight-board-filter.js').FlightBoardFilter} [filter]
 */
export function drawFlightBoardCanvas(ctx, data, message, filter = 'all') {
    drawBoardFrame(ctx);

    const headerH = 64;
    const footerH = 30;
    const padX = 20;
    const contentTop = headerH + 10;
    const contentBottom = CANVAS_H - footerH - 12;
    const contentH = contentBottom - contentTop;
    const colGap = 12;
    const colW = (CANVAS_W - padX * 2 - colGap) / 2;

    ctx.font = LED_FONT_TITLE;
    ctx.textAlign = 'center';
    drawLedText(ctx, 'MATSUYAMA  MYJ', CANVAS_W / 2, 46, COLOR_LED_BRIGHT, true);
    ctx.font = LED_FONT_HEADER;
    const dateLabel = data?.serviceDate ? data.serviceDate.replace(/-/g, '/') : '';
    const filterTag = boardFilterCanvasTag(filter);
    let subTitle = dateLabel ? `運行状況  ${dateLabel}` : '運行状況';
    if (filterTag) subTitle = `${subTitle}  ${filterTag}`;
    if (data?.layoutAlert) subTitle += '  LAYOUT ALERT';
    drawLedText(ctx, subTitle, CANVAS_W / 2, 78, data?.layoutAlert ? COLOR_ERROR : COLOR_LED_DIM, false);

    const boardData = filterBoardData(data, filter);

    if (!boardData || !boardData.ok) {
        ctx.font = LED_FONT;
        ctx.textAlign = 'center';
        const msg = message || boardData?.error || data?.error || 'データ取得中…';
        drawLedText(ctx, msg, CANVAS_W / 2, CANVAS_H / 2, COLOR_ERROR, true);
        drawScanlines(ctx);
        return;
    }

    const depX = padX;
    const arrX = padX + colW + colGap;
    drawSection(ctx, '出発 DEP', boardData.departures || [], depX, contentTop, colW, contentH, 'destination');
    drawSection(ctx, '到着 ARR', boardData.arrivals || [], arrX, contentTop, colW, contentH, 'counterpart');

    ctx.font = LED_FONT_SM;
    ctx.textAlign = 'right';
    const updated = boardData.updatedAt ? new Date(boardData.updatedAt).toLocaleString('ja-JP') : '';
    drawLedText(ctx, updated ? `UPD ${updated}` : '', CANVAS_W - padX, CANVAS_H - 14, COLOR_LED_DIM);
    ctx.textAlign = 'left';
    const srcLabel =
        data.dataSource === 'backup'
            ? 'SRC ODPT/JETSTAR (backup)'
            : 'SRC 松山空港';
    drawLedText(ctx, srcLabel, padX, CANVAS_H - 14, COLOR_LED_DIM);

    drawScanlines(ctx);
}

/**
 * スラッシュ区切りの複数値を配列に
 * @param {unknown} raw
 * @returns {string[]}
 */
function splitMultiParts(raw) {
    const s = String(raw || '').trim();
    if (!s || s === '—') return [];
    return s.split('/').map((p) => p.trim()).filter(Boolean);
}

/**
 * 4件以上なら2列×2行で描画、それ以外は1行
 * @param {CanvasRenderingContext2D} ctx
 * @param {unknown} raw
 * @param {number} x
 * @param {number} y
 * @param {number} xEnd
 * @param {string} color
 * @param {number} [maxSingleLen]
 */
function drawCellValue(ctx, raw, x, y, xEnd, color, maxSingleLen = 14) {
    const parts = splitMultiParts(raw);
    if (parts.length < 4) {
        ctx.font = LED_FONT;
        const text = parts.length ? parts.join('/') : String(raw || '—');
        drawLedText(ctx, text.slice(0, maxSingleLen), x, y, color, false);
        return ROW_H;
    }

    const colW = Math.max(36, (xEnd - x - 4) / 2);
    const slots = parts.slice(0, 4);
    ctx.font = LED_FONT_SM;
    for (let row = 0; row < 2; row++) {
        if (slots[row]) {
            drawLedText(ctx, slots[row].slice(0, 12), x, y + row * STACK_LINE_H, color, false);
        }
        if (slots[row + 2]) {
            drawLedText(ctx, slots[row + 2].slice(0, 12), x + colW, y + row * STACK_LINE_H, color, false);
        }
    }
    return ROW_H + STACK_LINE_H;
}

/**
 * 等幅フォントで n 文字分の幅を測る
 * @param {CanvasRenderingContext2D} ctx
 * @param {string} font
 * @param {number} chars
 * @returns {number}
 */
function measureMonoCharWidth(ctx, font, chars) {
    ctx.font = font;
    return ctx.measureText('0'.repeat(Math.max(0, chars))).width;
}

/**
 * 1区画（出発 or 到着）を描画
 * @param {CanvasRenderingContext2D} ctx
 * @param {string} title
 * @param {object[]} rows
 * @param {number} x0
 * @param {number} y0
 * @param {number} w
 * @param {number} h
 * @param {'destination'|'counterpart'} counterpartKey
 */
function drawSection(ctx, title, rows, x0, y0, w, h, counterpartKey) {
    ctx.fillStyle = COLOR_PANEL;
    ctx.fillRect(x0, y0, w, h);
    ctx.strokeStyle = COLOR_BORDER;
    ctx.lineWidth = 2;
    ctx.strokeRect(x0 + 1, y0 + 1, w - 2, h - 2);

    ctx.font = LED_FONT_HEADER;
    ctx.textAlign = 'left';
    drawLedText(ctx, `■ ${title}`, x0 + 14, y0 + 32, COLOR_LED_BRIGHT, true);

    const placeLabel = counterpartKey === 'destination' ? '行き先' : '出発';
    const cols = ['時刻', '便名', '会社', placeLabel, '状況'];
    const anyChanged = rows.some((r) => r.timeChanged);
    const colRatios = anyChanged ? COL_RATIOS_WITH_CHANGED : COL_RATIOS_NO_CHANGED;
    const colX = colRatios.map((r) => x0 + 12 + w * r);
    const statusColX = colX[4] + measureMonoCharWidth(ctx, LED_FONT, STATUS_COL_SHIFT_CHARS);
    const nearestIdx = findNearestRowIndex(rows);

    ctx.font = LED_FONT_SM;
    ctx.fillStyle = COLOR_LED_DIM;
    const headerY = y0 + 58;
    cols.forEach((c, i) => {
        const x = i === 4 ? statusColX : colX[i];
        drawLedText(ctx, c, x, headerY, COLOR_LED_DIM);
    });

    ctx.strokeStyle = 'rgba(255, 180, 50, 0.35)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x0 + 8, y0 + 68);
    ctx.lineTo(x0 + w - 8, y0 + 68);
    ctx.stroke();

    let y = y0 + 96;
    if (rows.length === 0) {
        ctx.font = LED_FONT;
        drawLedText(ctx, '--- NO DATA ---', x0 + 14, y, COLOR_LED_DIM);
        return;
    }

    for (let ri = 0; ri < rows.length; ri++) {
        const row = rows[ri];
        if (y > y0 + h - 24) break;

        const place =
            counterpartKey === 'destination'
                ? (row.destination || row.counterpart || '—')
                : (row.origin || row.counterpart || '—');
        const displayTime = row.displayTime || row.scheduledTime || row.time || '—';
        const changeNote = row.changeNote && row.changeNote !== '-' ? String(row.changeNote) : '';
        const remark = row.remark ? String(row.remark) : '';
        let statusText = '—';
        if (changeNote) {
            statusText = changeNote;
        } else if (remark) {
            statusText = remark;
        } else if (row.status) {
            statusText = String(row.status);
        }

        const flightParts = splitMultiParts(row.flightNumber);
        const airlineParts = splitMultiParts(row.airline);
        const stackRow = flightParts.length >= 4 || airlineParts.length >= 4;
        let rowH = stackRow ? ROW_H + STACK_LINE_H : ROW_H;

        if (ri === nearestIdx) {
            ctx.fillStyle = COLOR_NOW_NEAR;
            ctx.fillRect(x0 + 6, y - 22, w - 12, rowH);
        }

        ctx.font = LED_FONT;
        const textColor = row.completed ? COLOR_LED_DIM : COLOR_LED;
        const statusColor = /欠航|遅延|キャンセ/i.test(statusText) ? COLOR_ERROR : textColor;
        const timeColor = row.timeChanged ? COLOR_LED_HIGHLIGHT : textColor;
        drawLedText(ctx, String(displayTime).slice(0, 8), colX[0], y, timeColor, row.timeChanged);
        if (row.timeChanged) {
            const tw = ctx.measureText(String(displayTime).slice(0, 8)).width;
            drawLedText(ctx, 'changed', colX[0] + tw + 10, y, COLOR_LED_HIGHLIGHT, false);
        }
        rowH = Math.max(
            rowH,
            drawCellValue(ctx, row.flightNumber, colX[1], y, colX[2], textColor, 14)
        );
        rowH = Math.max(
            rowH,
            drawCellValue(ctx, row.airline, colX[2], y, colX[3], textColor, 18)
        );
        drawLedText(ctx, String(place).slice(0, 14), colX[3], y, textColor, false);
        drawLedText(ctx, statusText.slice(0, 24), statusColX, y, statusColor, false);
        y += rowH;
    }
}

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {string} text
 * @param {number} x
 * @param {number} y
 * @param {number} maxWidth
 * @param {number} lineHeight
 */
function wrapText(ctx, text, x, y, maxWidth, lineHeight) {
    ctx.textAlign = 'center';
    const words = String(text).split(/\s+/);
    let line = '';
    let cy = y;
    for (const w of words) {
        const test = line ? `${line} ${w}` : w;
        if (ctx.measureText(test).width > maxWidth && line) {
            drawLedText(ctx, line, x, cy, COLOR_ERROR, true);
            line = w;
            cy += lineHeight;
        } else {
            line = test;
        }
    }
    if (line) drawLedText(ctx, line, x, cy, COLOR_ERROR, true);
}

/**
 * ワールド内発着ボード用メッシュを生成する（平面 5:4）
 * @param {object} config position, rotation, scale
 * @returns {THREE.Mesh}
 */
export function createFlightBoardMesh(config) {
    const pos = config.position || { x: 0, y: 2, z: -5 };
    const rot = config.rotation || { x: 0, y: 0, z: 0 };
    const scale = config.scale || { x: 2, y: 2, z: 1 };

    const canvas = document.createElement('canvas');
    canvas.width = CANVAS_W;
    canvas.height = CANVAS_H;
    const ctx = canvas.getContext('2d');
    drawFlightBoardCanvas(ctx, null, '読込中…');

    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    const geom = new THREE.PlaneGeometry(BOARD_ASPECT_W, BOARD_ASPECT_H);
    const mat = new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(geom, mat);
    mesh.position.set(pos.x, pos.y, pos.z);
    mesh.rotation.set(
        rot.x * Math.PI / 180,
        rot.y * Math.PI / 180,
        rot.z * Math.PI / 180
    );
    mesh.scale.set(scale.x, scale.y, scale.z);
    mesh.userData.flightBoardConfig = {
        position: { ...pos },
        rotation: { ...rot },
        scale: { ...scale },
        filter: normalizeBoardFilter(config.filter),
    };
    mesh.userData.flightBoardCanvas = canvas;
    mesh.userData.flightBoardTexture = tex;
    return mesh;
}

/**
 * キャッシュされた board API を取得する
 * @returns {Promise<object>}
 */
export async function fetchFlightBoardData() {
    const res = await fetch(BOARD_API, { credentials: 'same-origin' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
        return {
            ok: false,
            error: data.error || `HTTP ${res.status}`,
            departures: [],
            arrivals: [],
        };
    }
    return data;
}

/**
 * メッシュのテクスチャを board データで更新する
 * @param {THREE.Mesh} mesh
 * @param {object} data
 */
export function paintFlightBoardMesh(mesh, data) {
    const canvas = mesh.userData.flightBoardCanvas;
    const tex = mesh.userData.flightBoardTexture;
    if (!canvas || !tex) return;
    const ctx = canvas.getContext('2d');
    const filter = normalizeBoardFilter(mesh.userData.flightBoardConfig?.filter);
    drawFlightBoardCanvas(ctx, data, data?.error, filter);
    tex.needsUpdate = true;
}

/**
 * メッシュのテクスチャを API データで更新する
 * @param {THREE.Mesh} mesh
 */
export async function updateFlightBoardMesh(mesh) {
    try {
        const data = await fetchFlightBoardData();
        paintFlightBoardMesh(mesh, data);
    } catch (e) {
        const canvas = mesh.userData.flightBoardCanvas;
        const tex = mesh.userData.flightBoardTexture;
        if (!canvas || !tex) return;
        const ctx = canvas.getContext('2d');
        const filter = normalizeBoardFilter(mesh.userData.flightBoardConfig?.filter);
        drawFlightBoardCanvas(
            ctx,
            null,
            e instanceof Error ? e.message : '取得失敗',
            filter
        );
        tex.needsUpdate = true;
    }
}

/**
 * シーン内の全発着ボードをポーリング更新する
 * @param {THREE.Object3D[]} meshes
 */
export function startFlightBoardPolling(meshes) {
    const list = meshes.filter((m) => m.userData?.flightBoardCanvas);
    if (!list.length) return () => {};

    const tick = async () => {
        try {
            const data = await fetchFlightBoardData();
            for (const m of list) {
                paintFlightBoardMesh(m, data);
            }
        } catch {
            for (const m of list) {
                updateFlightBoardMesh(m).catch(() => {});
            }
        }
    };
    tick();
    const id = setInterval(tick, POLL_MS);
    return () => clearInterval(id);
}
