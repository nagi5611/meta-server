// lib/glb-bounds.js — glTF Document から AABB（min/max/center/radius）を算出

/**
 * @typedef {{ min: [number, number, number], max: [number, number, number], center: [number, number, number], radius: number }} GlbBounds
 */

/**
 * @param {number[]} m 4x4 column-major
 * @param {number} x
 * @param {number} y
 * @param {number} z
 * @returns {[number, number, number]}
 */
function transformMat4Point(m, x, y, z) {
    const wx = m[0] * x + m[4] * y + m[8] * z + m[12];
    const wy = m[1] * x + m[5] * y + m[9] * z + m[13];
    const wz = m[2] * x + m[6] * y + m[10] * z + m[14];
    const ww = m[3] * x + m[7] * y + m[11] * z + m[15];
    if (ww !== 0 && ww !== 1) {
        return [wx / ww, wy / ww, wz / ww];
    }
    return [wx, wy, wz];
}

/**
 * @param {number[]} min
 * @param {number[]} max
 * @param {number} x
 * @param {number} y
 * @param {number} z
 */
function expandMinMax(min, max, x, y, z) {
    if (x < min[0]) min[0] = x;
    if (y < min[1]) min[1] = y;
    if (z < min[2]) min[2] = z;
    if (x > max[0]) max[0] = x;
    if (y > max[1]) max[1] = y;
    if (z > max[2]) max[2] = z;
}

/**
 * min/max から center と境界球半径を算出する
 * @param {[number, number, number]} min
 * @param {[number, number, number]} max
 * @returns {GlbBounds}
 */
export function boundsFromMinMax(min, max) {
    const center = [
        (min[0] + max[0]) * 0.5,
        (min[1] + max[1]) * 0.5,
        (min[2] + max[2]) * 0.5,
    ];
    const dx = max[0] - center[0];
    const dy = max[1] - center[1];
    const dz = max[2] - center[2];
    const radius = Math.sqrt(dx * dx + dy * dy + dz * dz);
    return {
        min: [min[0], min[1], min[2]],
        max: [max[0], max[1], max[2]],
        center: /** @type {[number, number, number]} */ (center),
        radius: Math.max(radius, 0.05),
    };
}

/**
 * @param {import('@gltf-transform/core').Node} node
 * @param {number[]} min
 * @param {number[]} max
 */
function accumulateNodeMeshBounds(node, min, max) {
    const mesh = node.getMesh();
    if (!mesh) return;

    const wm = node.getWorldMatrix();
    for (const prim of mesh.listPrimitives()) {
        const pos = prim.getAttribute('POSITION');
        if (!pos) continue;
        const arr = pos.getArray();
        if (!arr || arr.length < 3) continue;
        const count = pos.getCount();
        for (let i = 0; i < count; i++) {
            const ox = arr[i * 3];
            const oy = arr[i * 3 + 1];
            const oz = arr[i * 3 + 2];
            if (!Number.isFinite(ox) || !Number.isFinite(oy) || !Number.isFinite(oz)) continue;
            const [tx, ty, tz] = transformMat4Point(wm, ox, oy, oz);
            expandMinMax(min, max, tx, ty, tz);
        }
    }
}

/**
 * @param {import('@gltf-transform/core').Node} node
 * @param {number[]} min
 * @param {number[]} max
 */
function traverseNodeBounds(node, min, max) {
    accumulateNodeMeshBounds(node, min, max);
    for (const child of node.listChildren()) {
        traverseNodeBounds(child, min, max);
    }
}

/**
 * glTF Document の全シーンからメッシュ AABB を算出する
 * @param {import('@gltf-transform/core').Document} doc
 * @returns {GlbBounds | null}
 */
export function computeBoundsFromDocument(doc) {
    const root = doc.getRoot();
    const scenes = root.listScenes();
    if (!scenes.length) return null;

    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];

    for (const scene of scenes) {
        for (const child of scene.listChildren()) {
            traverseNodeBounds(child, min, max);
        }
    }

    if (!Number.isFinite(min[0]) || !Number.isFinite(max[0])) {
        return null;
    }

    return boundsFromMinMax(
        /** @type {[number, number, number]} */ (min),
        /** @type {[number, number, number]} */ (max),
    );
}

/**
 * 複数 bounds をマージする
 * @param {(GlbBounds | null | undefined)[]} list
 * @returns {GlbBounds | null}
 */
export function mergeGlbBoundsList(list) {
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    let any = false;

    for (const b of list) {
        if (!b || !Array.isArray(b.min) || !Array.isArray(b.max)) continue;
        any = true;
        expandMinMax(min, max, b.min[0], b.min[1], b.min[2]);
        expandMinMax(min, max, b.max[0], b.max[1], b.max[2]);
    }

    if (!any) return null;
    return boundsFromMinMax(
        /** @type {[number, number, number]} */ (min),
        /** @type {[number, number, number]} */ (max),
    );
}

/**
 * JSON シリアライズ用に数値を丸める
 * @param {GlbBounds} b
 * @param {number} [decimals]
 * @returns {GlbBounds}
 */
export function roundGlbBounds(b, decimals = 5) {
    const f = (n) => {
        const r = Math.round(n * 10 ** decimals) / 10 ** decimals;
        return Object.is(r, -0) ? 0 : r;
    };
    return {
        min: [f(b.min[0]), f(b.min[1]), f(b.min[2])],
        max: [f(b.max[0]), f(b.max[1]), f(b.max[2])],
        center: [f(b.center[0]), f(b.center[1]), f(b.center[2])],
        radius: f(b.radius),
    };
}
