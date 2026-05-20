// addons/matsuyama-flights/client/flight-board-mesh.js — 発着情報 Canvas テクスチャ板（電光掲示板風・横 3:縦 2）
import * as THREE from 'three';

const BOARD_API = '/api/addons/matsuyama-flights/board';
const POLL_MS = 60_000;
const MAX_ROWS_PER_SECTION = 10;

/** テクスチャ・メッシュの縦横比（横 3 : 縦 2） */
export const BOARD_ASPECT_W = 3;
export const BOARD_ASPECT_H = 2;

export const CANVAS_W = 1536;
export const CANVAS_H = 1024;

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
 * 発着ボード用キャンバスに描画する
 * @param {CanvasRenderingContext2D} ctx
 * @param {object|null} data
 * @param {string} [message]
 */
export function drawFlightBoardCanvas(ctx, data, message) {
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
    drawLedText(ctx, '運行状況', CANVAS_W / 2, 78, COLOR_LED_DIM, false);

    if (!data || !data.ok) {
        ctx.font = LED_FONT;
        ctx.textAlign = 'center';
        const msg = message || data?.error || 'データ取得中…';
        drawLedText(ctx, msg, CANVAS_W / 2, CANVAS_H / 2, COLOR_ERROR, true);
        drawScanlines(ctx);
        return;
    }

    const depX = padX;
    const arrX = padX + colW + colGap;
    drawSection(ctx, '出発 DEP', data.departures || [], depX, contentTop, colW, contentH, 'destination');
    drawSection(ctx, '到着 ARR', data.arrivals || [], arrX, contentTop, colW, contentH, 'counterpart');

    ctx.font = LED_FONT_SM;
    ctx.textAlign = 'right';
    const updated = data.updatedAt ? new Date(data.updatedAt).toLocaleString('ja-JP') : '';
    drawLedText(ctx, updated ? `UPD ${updated}` : '', CANVAS_W - padX, CANVAS_H - 14, COLOR_LED_DIM);
    ctx.textAlign = 'left';
    drawLedText(ctx, 'SRC ODPT / JETSTAR', padX, CANVAS_H - 14, COLOR_LED_DIM);

    drawScanlines(ctx);
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

    const placeLabel = counterpartKey === 'destination' ? '行先' : '出発';
    const cols = ['時刻', '便名', '会社', placeLabel, '状況'];
    const colRatios = [0, 0.17, 0.34, 0.52, 0.76];
    const colX = colRatios.map((r) => x0 + 12 + w * r);

    ctx.font = LED_FONT_SM;
    ctx.fillStyle = COLOR_LED_DIM;
    const headerY = y0 + 58;
    cols.forEach((c, i) => drawLedText(ctx, c, colX[i], headerY, COLOR_LED_DIM));

    ctx.strokeStyle = 'rgba(255, 180, 50, 0.35)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x0 + 8, y0 + 68);
    ctx.lineTo(x0 + w - 8, y0 + 68);
    ctx.stroke();

    const slice = rows.slice(0, MAX_ROWS_PER_SECTION);
    let y = y0 + 96;
    const rowH = 30;
    if (slice.length === 0) {
        ctx.font = LED_FONT;
        drawLedText(ctx, '--- NO DATA ---', x0 + 14, y, COLOR_LED_DIM);
        return;
    }

    for (let ri = 0; ri < slice.length; ri++) {
        const row = slice[ri];
        if (y > y0 + h - 28) break;

        if (row.isLastCompleted) {
            ctx.fillStyle = 'rgba(255, 204, 51, 0.14)';
            ctx.fillRect(x0 + 6, y - 22, w - 12, rowH);
            ctx.font = LED_FONT_SM;
            //drawLedText(ctx, '>> LAST', x0 + 14, y - 6, COLOR_LED_HIGHLIGHT, true);
        }

        const place =
            counterpartKey === 'destination'
                ? (row.destination || row.counterpart || '—')
                : (row.origin || row.counterpart || '—');
        const displayTime = row.isLastCompleted
            ? (row.actualTime || row.time || row.scheduledTime || '—')
            : (row.scheduledTime || row.time || '—');
        const status = String(row.status || '—');
        const cells = [
            displayTime,
            row.flightNumber || '—',
            row.airline || '—',
            place,
            status,
        ];

        ctx.font = LED_FONT;
        const textColor = row.isLastCompleted ? COLOR_LED_HIGHLIGHT : COLOR_LED;
        const statusColor = /欠航|遅延|キャンセ/i.test(status) ? COLOR_ERROR : textColor;
        cells.forEach((c, i) => {
            const color = i === 4 ? statusColor : textColor;
            drawLedText(ctx, String(c).slice(0, 14), colX[i], y, color, row.isLastCompleted && i === 0);
        });
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
 * ワールド内発着ボード用メッシュを生成する（平面 3:2）
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
 * メッシュのテクスチャを API データで更新する
 * @param {THREE.Mesh} mesh
 */
export async function updateFlightBoardMesh(mesh) {
    const canvas = mesh.userData.flightBoardCanvas;
    const tex = mesh.userData.flightBoardTexture;
    if (!canvas || !tex) return;
    const ctx = canvas.getContext('2d');
    try {
        const data = await fetchFlightBoardData();
        drawFlightBoardCanvas(ctx, data, data.error);
    } catch (e) {
        drawFlightBoardCanvas(ctx, null, e instanceof Error ? e.message : '取得失敗');
    }
    tex.needsUpdate = true;
}

/**
 * シーン内の全発着ボードをポーリング更新する
 * @param {THREE.Object3D[]} meshes
 */
export function startFlightBoardPolling(meshes) {
    const list = meshes.filter((m) => m.userData?.flightBoardCanvas);
    if (!list.length) return () => {};

    const tick = () => {
        for (const m of list) {
            updateFlightBoardMesh(m).catch(() => {});
        }
    };
    tick();
    const id = setInterval(tick, POLL_MS);
    return () => clearInterval(id);
}
