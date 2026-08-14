// addons/qr-ar/client/ar/qr-corner-order.js — QR 四隅の復元・TL/TR/BR/BL 順序付け

/**
 * @typedef {{ x: number, y: number }} Point2D
 * @typedef {{ topLeftCorner: Point2D, topRightCorner: Point2D, bottomRightCorner: Point2D, bottomLeftCorner: Point2D }} QrLocation
 */

/**
 * @param {Point2D} a
 * @param {Point2D} b
 */
function dist2(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y);
}

/**
 * 4 点が矩形らしいかスコア（大きいほど良い）
 * @param {Point2D[]} quad
 */
function scoreRectangle(quad) {
    let angleScore = 0;
    let sideScore = 0;

    for (let i = 0; i < 4; i++) {
        const a = quad[i];
        const b = quad[(i + 1) % 4];
        const c = quad[(i + 2) % 4];
        const v1x = b.x - a.x;
        const v1y = b.y - a.y;
        const v2x = c.x - b.x;
        const v2y = c.y - b.y;
        const l1 = Math.hypot(v1x, v1y);
        const l2 = Math.hypot(v2x, v2y);
        if (l1 < 2 || l2 < 2) return -Infinity;
        const cos = (v1x * v2x + v1y * v2y) / (l1 * l2);
        angleScore += 1 - Math.abs(cos);
    }

    const d01 = dist2(quad[0], quad[1]);
    const d12 = dist2(quad[1], quad[2]);
    const d23 = dist2(quad[2], quad[3]);
    const d30 = dist2(quad[3], quad[0]);
    sideScore = 2 - (Math.abs(d01 - d23) + Math.abs(d12 - d30)) / Math.max(d01, d12, 1);

    return angleScore + sideScore;
}

/**
 * 3 点から第 4 角を復元（3 候補のうち最も矩形に近いものを選ぶ）
 * @param {Point2D} p0
 * @param {Point2D} p1
 * @param {Point2D} p2
 * @returns {Point2D}
 */
export function reconstructFourthCorner(p0, p1, p2) {
    const candidates = [
        { x: p1.x + p2.x - p0.x, y: p1.y + p2.y - p0.y },
        { x: p0.x + p2.x - p1.x, y: p0.y + p2.y - p1.y },
        { x: p0.x + p1.x - p2.x, y: p0.y + p1.y - p2.y },
    ];

    let best = candidates[0];
    let bestScore = -Infinity;

    for (const c of candidates) {
        const score = scoreRectangle([p0, p1, p2, c]);
        if (score > bestScore) {
            bestScore = score;
            best = c;
        }
    }

    return best;
}

/**
 * 3〜4 点を TL, TR, BR, BL に並べ替える（斜め・回転でも centroid + 外積で判定）
 * @param {Point2D[]} points
 * @returns {QrLocation|null}
 */
export function orderQuadCornersTLTRBRBL(points) {
    if (!points?.length) return null;

    const valid = points.filter((p) => p && Number.isFinite(p.x) && Number.isFinite(p.y));
    if (valid.length < 3) return null;

    let quad = valid.slice(0, 4);
    if (quad.length === 3) {
        quad = [...quad, reconstructFourthCorner(quad[0], quad[1], quad[2])];
    }
    if (quad.length !== 4) return null;

    const cx = (quad[0].x + quad[1].x + quad[2].x + quad[3].x) / 4;
    const cy = (quad[0].y + quad[1].y + quad[2].y + quad[3].y) / 4;

    const cyclic = [...quad].sort(
        (a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx)
    );

    let tlIdx = 0;
    for (let i = 1; i < 4; i++) {
        const score = cyclic[i].x + cyclic[i].y;
        const best = cyclic[tlIdx].x + cyclic[tlIdx].y;
        if (score < best) tlIdx = i;
    }

    const tl = cyclic[tlIdx];
    const next = cyclic[(tlIdx + 1) % 4];
    const mid = cyclic[(tlIdx + 2) % 4];
    const prev = cyclic[(tlIdx + 3) % 4];

    const vNext = { x: next.x - tl.x, y: next.y - tl.y };
    const vPrev = { x: prev.x - tl.x, y: prev.y - tl.y };
    const cross = vNext.x * vPrev.y - vNext.y * vPrev.x;

    let tr;
    let br;
    let bl;
    if (cross > 0) {
        tr = next;
        br = mid;
        bl = prev;
    } else {
        bl = next;
        br = mid;
        tr = prev;
    }

    return {
        topLeftCorner: { x: tl.x, y: tl.y },
        topRightCorner: { x: tr.x, y: tr.y },
        bottomRightCorner: { x: br.x, y: br.y },
        bottomLeftCorner: { x: bl.x, y: bl.y },
    };
}

/**
 * 検出器の location を正規化する
 * @param {QrLocation|null|undefined} location
 * @returns {QrLocation|null}
 */
export function normalizeQrLocation(location) {
    if (!location) return null;
    return orderQuadCornersTLTRBRBL([
        location.topLeftCorner,
        location.topRightCorner,
        location.bottomRightCorner,
        location.bottomLeftCorner,
    ]);
}

/**
 * 任意の点列から QrLocation を構築（3 点なら第 4 角を復元）
 * @param {Point2D[]} points
 * @returns {QrLocation|null}
 */
export function qrLocationFromPoints(points) {
    return orderQuadCornersTLTRBRBL(points);
}
