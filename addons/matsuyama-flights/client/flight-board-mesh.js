// addons/matsuyama-flights/client/flight-board-mesh.js — 発着情報 Canvas テクスチャ板
import * as THREE from 'three';

const BOARD_API = '/api/addons/matsuyama-flights/board';
const POLL_MS = 60_000;
const MAX_ROWS_PER_SECTION = 8;
const CANVAS_W = 1024;
const CANVAS_H = 1024;

/**
 * 発着ボード用キャンバスに描画する
 * @param {CanvasRenderingContext2D} ctx
 * @param {object|null} data
 * @param {string} [message]
 */
export function drawFlightBoardCanvas(ctx, data, message) {
    ctx.fillStyle = '#0a1628';
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

    ctx.fillStyle = '#e8f4ff';
    ctx.font = 'bold 42px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('松山空港 発着情報', CANVAS_W / 2, 52);

    if (!data || !data.ok) {
        ctx.fillStyle = '#aac4dd';
        ctx.font = '28px sans-serif';
        const msg = message || data?.error || 'データ取得中…';
        wrapText(ctx, msg, CANVAS_W / 2, 120, CANVAS_W - 80, 34);
        return;
    }

    const half = CANVAS_H / 2;
    drawSection(ctx, '出発', data.departures || [], 72, half - 16, 'destination');
    drawSection(ctx, '到着', data.arrivals || [], half + 8, CANVAS_H - 72, 'counterpart');

    ctx.fillStyle = '#6688aa';
    ctx.font = '20px sans-serif';
    ctx.textAlign = 'right';
    const updated = data.updatedAt ? new Date(data.updatedAt).toLocaleString('ja-JP') : '';
    ctx.fillText(updated ? `更新: ${updated}` : '', CANVAS_W - 24, CANVAS_H - 16);
    ctx.textAlign = 'left';
    ctx.font = '18px sans-serif';
    ctx.fillText('出典: 公共交通オープンデータセンター', 24, CANVAS_H - 16);
}

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {string} title
 * @param {object[]} rows
 * @param {number} y0
 * @param {number} y1
 * @param {'destination'|'counterpart'} counterpartKey
 */
function drawSection(ctx, title, rows, y0, y1, counterpartKey) {
    const h = y1 - y0;
    ctx.fillStyle = '#132238';
    ctx.fillRect(16, y0, CANVAS_W - 32, h);

    ctx.fillStyle = '#7ec8ff';
    ctx.font = 'bold 32px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(title, 32, y0 + 40);

    const cols = ['時刻', '便名', '会社', counterpartKey === 'destination' ? '行き先' : '出発地', '状況'];
    const colX = [32, 140, 280, 400, 720];
    ctx.fillStyle = '#8899aa';
    ctx.font = '22px sans-serif';
    cols.forEach((c, i) => ctx.fillText(c, colX[i], y0 + 72));

    const slice = rows.slice(0, MAX_ROWS_PER_SECTION);
    let y = y0 + 108;
    const rowH = 36;
    if (slice.length === 0) {
        ctx.fillStyle = '#8899aa';
        ctx.font = '24px sans-serif';
        ctx.fillText('（該当便なし）', 32, y);
        return;
    }
    for (let ri = 0; ri < slice.length; ri++) {
        const row = slice[ri];
        if (y > y1 - 24) break;

        if (row.isLastCompleted) {
            ctx.fillStyle = 'rgba(126, 200, 255, 0.18)';
            ctx.fillRect(24, y - 26, CANVAS_W - 48, rowH);
            ctx.fillStyle = '#9ed4ff';
            ctx.font = '20px sans-serif';
            ctx.fillText('▶ 直近', 32, y - 8);
        }

        const place =
            counterpartKey === 'destination'
                ? (row.destination || row.counterpart || '—')
                : (row.origin || row.counterpart || '—');
        const displayTime = row.isLastCompleted
            ? (row.actualTime || row.time || row.scheduledTime || '—')
            : (row.scheduledTime || row.time || '—');
        const cells = [
            displayTime,
            row.flightNumber || '—',
            row.airline || '—',
            place,
            row.status || '—',
        ];
        ctx.fillStyle = row.isLastCompleted ? '#dff4ff' : '#e8f4ff';
        ctx.font = '24px sans-serif';
        cells.forEach((c, i) => ctx.fillText(String(c).slice(0, 16), colX[i], y));
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
    const words = String(text).split(/\s+/);
    let line = '';
    let cy = y;
    for (const w of words) {
        const test = line ? `${line} ${w}` : w;
        if (ctx.measureText(test).width > maxWidth && line) {
            ctx.fillText(line, x, cy);
            line = w;
            cy += lineHeight;
        } else {
            line = test;
        }
    }
    if (line) ctx.fillText(line, x, cy);
}

/**
 * ワールド内発着ボード用メッシュを生成する
 * @param {object} config position, rotation, scale
 * @returns {THREE.Mesh}
 */
export function createFlightBoardMesh(config) {
    const pos = config.position || { x: 0, y: 2, z: -5 };
    const rot = config.rotation || { x: 0, y: 0, z: 0 };
    const scale = config.scale || { x: 2, y: 3.5, z: 1 };

    const canvas = document.createElement('canvas');
    canvas.width = CANVAS_W;
    canvas.height = CANVAS_H;
    const ctx = canvas.getContext('2d');
    drawFlightBoardCanvas(ctx, null, '読込中…');

    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    const geom = new THREE.PlaneGeometry(1, 1);
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
