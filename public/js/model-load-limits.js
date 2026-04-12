/**
 * public/js/model-load-limits.js — 大規模3Dモデルによるクライアント落ち対策（共有定数・検査）
 */

/** OBJ はテキストでメモリ膨張しやすいため GLB より厳しめ */
export const MODEL_MAX_BYTES_OBJ = 55 * 1024 * 1024;

/** GLB / glTF バイナリ（アップロード上限・nginx / server.js の multer と揃える） */
export const MODEL_MAX_BYTES_GLTF = 500 * 1024 * 1024;

/** 三角面数の読み込み拒否上限（実質無制限） */
export const MODEL_MAX_TRIANGLES_TOTAL = Number.MAX_SAFE_INTEGER;

/**
 * これを超えるとシャドウマップ負荷軽減のため cast/receive shadow を付けない
 */
export const MODEL_SHADOW_DISABLE_TRIANGLE_THRESHOLD = 400_000;

/**
 * HEAD で Content-Length を取得（取得できなければ null）
 * @param {string} url
 * @returns {Promise<number|null>}
 */
export async function fetchModelContentLength(url) {
    try {
        const r = await fetch(url, { method: 'HEAD', credentials: 'same-origin' });
        if (!r.ok) return null;
        const cl = r.headers.get('Content-Length');
        if (cl == null || cl === '') return null;
        const n = parseInt(cl, 10);
        return Number.isFinite(n) && n >= 0 ? n : null;
    } catch {
        return null;
    }
}

/**
 * Object3D 配下のメッシュの三角面数の合計
 * @param {{ traverse: (fn: (c: object) => void) => void }} root
 * @returns {number}
 */
export function countTrianglesInObject(root) {
    let n = 0;
    root.traverse((c) => {
        if (!c.isMesh || !c.geometry) return;
        const g = c.geometry;
        const idx = g.index;
        const pos = g.attributes && g.attributes.position;
        if (idx) {
            n += idx.count / 3;
        } else if (pos) {
            n += pos.count / 3;
        }
    });
    return Math.floor(n);
}
