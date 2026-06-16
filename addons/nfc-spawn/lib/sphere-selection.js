// addons/nfc-spawn/lib/sphere-selection.js — 球内モデル選択（Node / ブラウザ共用・Three.js 非依存）

/**
 * @typedef {{ min: [number, number, number], max: [number, number, number], center: [number, number, number], radius: number }} PrefabBounds
 */

/**
 * @param {unknown} raw
 * @returns {PrefabBounds | null}
 */
export function parsePrefabBounds(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const o = /** @type {Record<string, unknown>} */ (raw);
    const center = o.center;
    const radius = o.radius;
    if (!Array.isArray(center) || center.length < 3) return null;
    const cx = Number(center[0]);
    const cy = Number(center[1]);
    const cz = Number(center[2]);
    if (![cx, cy, cz].every(Number.isFinite)) return null;
    const min = o.min;
    const max = o.max;
    const mn =
        Array.isArray(min) && min.length >= 3
            ? [Number(min[0]), Number(min[1]), Number(min[2])]
            : [cx, cy, cz];
    const mx =
        Array.isArray(max) && max.length >= 3
            ? [Number(max[0]), Number(max[1]), Number(max[2])]
            : [cx, cy, cz];
    if (![...mn, ...mx].every(Number.isFinite)) return null;
    const r = Number(radius);
    return {
        min: /** @type {[number, number, number]} */ (mn),
        max: /** @type {[number, number, number]} */ (mx),
        center: [cx, cy, cz],
        radius: Number.isFinite(r) && r > 0 ? r : 0.05,
    };
}

/**
 * @param {object} manifest
 */
export function normalizePrefabManifest(manifest) {
    const v = manifest && typeof manifest === 'object' ? manifest : {};
    const parts = Array.isArray(v.parts) ? v.parts : [];
    return {
        version: typeof v.version === 'number' ? v.version : 1,
        prefabGroupId: String(v.prefabGroupId || '').trim(),
        displayName: String(v.displayName || '').trim() || 'prefab',
        bounds: parsePrefabBounds(v.bounds),
        parts: parts
            .map((p) => ({
                file: String(p?.file || '').replace(/^\//, '').trim(),
                bounds: parsePrefabBounds(p?.bounds),
            }))
            .filter((p) => p.file.toLowerCase().endsWith('.glb')),
    };
}

/**
 * @param {string} file
 */
export function resolvePrefabPartAssetPath(file) {
    const f = String(file || '').trim().replace(/^\//, '');
    if (!f) return f;
    if (f.startsWith('models/') || f.startsWith('plane/')) return f;
    return `models/${f}`;
}

/**
 * @param {string} pathOrManifest
 */
export function isPlaneAsset(pathOrManifest) {
    const p = String(pathOrManifest || '').trim();
    return p.startsWith('plane/');
}

/**
 * @param {{ x: number, y: number, z: number }} p
 * @param {number} R
 * @param {{ x: number, y: number, z: number }} min
 * @param {{ x: number, y: number, z: number }} max
 */
export function aabbIntersectsSphere(p, R, min, max) {
    const cx = Math.max(min.x, Math.min(max.x, p.x));
    const cy = Math.max(min.y, Math.min(max.y, p.y));
    const cz = Math.max(min.z, Math.min(max.z, p.z));
    const dx = p.x - cx;
    const dy = p.y - cy;
    const dz = p.z - cz;
    return Math.sqrt(dx * dx + dy * dy + dz * dz) <= R;
}

/**
 * @param {{ x: number, y: number, z: number }} a
 * @param {number} ra
 * @param {{ x: number, y: number, z: number }} b
 * @param {number} rb
 */
export function spheresIntersect(a, ra, b, rb) {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    const dz = a.z - b.z;
    return Math.sqrt(dx * dx + dy * dy + dz * dz) <= ra + rb;
}

/**
 * @param {number} deg
 */
function degToRad(deg) {
    return (deg * Math.PI) / 180;
}

/**
 * @param {{ x: number, y: number, z: number }} rotationDeg
 * @param {{ x: number, y: number, z: number }} local
 * @param {{ x: number, y: number, z: number }} scale
 */
function transformLocalPoint(rotationDeg, local, scale) {
    const sx = scale.x;
    const sy = scale.y;
    const sz = scale.z;
    let x = local.x * sx;
    let y = local.y * sy;
    let z = local.z * sz;
    const rx = degToRad(rotationDeg.x);
    const ry = degToRad(rotationDeg.y);
    const rz = degToRad(rotationDeg.z);
    const cx = Math.cos(rx);
    const sxr = Math.sin(rx);
    const cy = Math.cos(ry);
    const syr = Math.sin(ry);
    const cz = Math.cos(rz);
    const szr = Math.sin(rz);
    let x1 = x;
    let y1 = cy * y - syr * z;
    let z1 = syr * y + cy * z;
    let x2 = cz * x1 + szr * y1;
    let y2 = -szr * x1 + cz * y1;
    let z2 = z1;
    const y3 = cx * y2 - sxr * z2;
    const z3 = sxr * y2 + cx * z2;
    return { x: x2, y: y3, z: z3 };
}

/**
 * @param {object} config models[] 要素
 * @param {PrefabBounds} manifestBounds
 */
export function computeWorldLoadSphere(config, manifestBounds) {
    const position = config.position || { x: 0, y: 0, z: 0 };
    const rotation = config.rotation || { x: 0, y: 0, z: 0 };
    const scale = config.scale || { x: 1, y: 1, z: 1 };
    const local = { x: manifestBounds.center[0], y: manifestBounds.center[1], z: manifestBounds.center[2] };
    const rotated = transformLocalPoint(rotation, local, scale);
    const maxScale = Math.max(Math.abs(scale.x), Math.abs(scale.y), Math.abs(scale.z), 1e-6);
    return {
        center: {
            x: position.x + rotated.x,
            y: position.y + rotated.y,
            z: position.z + rotated.z,
        },
        radius: manifestBounds.radius * maxScale,
    };
}

/**
 * @param {object} config
 * @param {PrefabBounds} bounds
 */
function worldAabbFromBounds(config, bounds) {
    const position = config.position || { x: 0, y: 0, z: 0 };
    const rotation = config.rotation || { x: 0, y: 0, z: 0 };
    const scale = config.scale || { x: 1, y: 1, z: 1 };
    const corners = [
        [bounds.min[0], bounds.min[1], bounds.min[2]],
        [bounds.min[0], bounds.min[1], bounds.max[2]],
        [bounds.min[0], bounds.max[1], bounds.min[2]],
        [bounds.min[0], bounds.max[1], bounds.max[2]],
        [bounds.max[0], bounds.min[1], bounds.min[2]],
        [bounds.max[0], bounds.min[1], bounds.max[2]],
        [bounds.max[0], bounds.max[1], bounds.min[2]],
        [bounds.max[0], bounds.max[1], bounds.max[2]],
    ];
    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;
    for (const c of corners) {
        const w = transformLocalPoint(rotation, { x: c[0], y: c[1], z: c[2] }, scale);
        const wx = position.x + w.x;
        const wy = position.y + w.y;
        const wz = position.z + w.z;
        minX = Math.min(minX, wx);
        minY = Math.min(minY, wy);
        minZ = Math.min(minZ, wz);
        maxX = Math.max(maxX, wx);
        maxY = Math.max(maxY, wy);
        maxZ = Math.max(maxZ, wz);
    }
    return {
        min: { x: minX, y: minY, z: minZ },
        max: { x: maxX, y: maxY, z: maxZ },
    };
}

/**
 * @param {{ x: number, y: number, z: number }} queryCenter
 * @param {number} queryRadius
 * @param {object} config
 * @param {PrefabBounds} bounds
 */
export function boundsIntersectQuerySphere(queryCenter, queryRadius, config, bounds) {
    const aabb = worldAabbFromBounds(config, bounds);
    return aabbIntersectsSphere(queryCenter, queryRadius, aabb.min, aabb.max);
}

/**
 * @typedef {{ worldModelIndex: number, entryKind: 'glb'|'prefab_whole'|'prefab_parts', label: string, prefabManifest?: string, partIndices?: number[], sourcePath?: string }} SelectionEntry
 */

/**
 * @param {object} options
 * @param {object[]} options.worldModels
 * @param {{ x: number, y: number, z: number }} options.center
 * @param {number} options.radius
 * @param {number} [options.defaultModelRadius]
 * @param {(manifestPath: string) => Promise<object|null>} options.loadManifest
 * @param {Set<number>} [options.excludeModelIndices]
 */
export async function selectModelsInSphere({
    worldModels,
    center,
    radius,
    defaultModelRadius = 5,
    loadManifest,
    excludeModelIndices,
}) {
    /** @type {SelectionEntry[]} */
    const entries = [];
    const models = Array.isArray(worldModels) ? worldModels : [];
    for (let i = 0; i < models.length; i++) {
        if (excludeModelIndices?.has(i)) continue;
        const config = typeof models[i] === 'string' ? { path: models[i] } : models[i];
        if (!config || typeof config !== 'object') continue;
        const pfm = String(config.prefabManifest || '').trim();
        const modelPath = String(config.path || '').trim();
        if (isPlaneAsset(pfm) || isPlaneAsset(modelPath)) continue;

        if (pfm) {
            const raw = await loadManifest(pfm);
            if (!raw) continue;
            const man = normalizePrefabManifest(raw);
            const partsWithBounds = man.parts
                .map((p, idx) => ({ p, idx }))
                .filter(({ p }) => p.bounds);
            if (partsWithBounds.length > 0) {
                const selected = [];
                for (const { p, idx } of partsWithBounds) {
                    const sphere = computeWorldLoadSphere(config, /** @type {PrefabBounds} */ (p.bounds));
                    if (spheresIntersect(center, radius, sphere.center, sphere.radius)) {
                        selected.push(idx);
                    }
                }
                if (selected.length > 0) {
                    entries.push({
                        worldModelIndex: i,
                        entryKind: 'prefab_parts',
                        label: man.displayName || pfm,
                        prefabManifest: pfm,
                        partIndices: selected,
                        sourcePath: modelPath || pfm,
                    });
                    continue;
                }
            }
            if (man.bounds) {
                if (
                    boundsIntersectQuerySphere(
                        center,
                        radius,
                        config,
                        /** @type {PrefabBounds} */ (man.bounds)
                    )
                ) {
                    entries.push({
                        worldModelIndex: i,
                        entryKind: 'prefab_whole',
                        label: man.displayName || pfm,
                        prefabManifest: pfm,
                        sourcePath: modelPath || pfm,
                    });
                }
                continue;
            }
            const pos = config.position || { x: 0, y: 0, z: 0 };
            if (spheresIntersect(center, radius, pos, defaultModelRadius)) {
                entries.push({
                    worldModelIndex: i,
                    entryKind: 'prefab_whole',
                    label: man.displayName || pfm,
                    prefabManifest: pfm,
                    sourcePath: modelPath || pfm,
                });
            }
            continue;
        }

        if (modelPath) {
            const pos = config.position || { x: 0, y: 0, z: 0 };
            if (spheresIntersect(center, radius, pos, defaultModelRadius)) {
                entries.push({
                    worldModelIndex: i,
                    entryKind: 'glb',
                    label: modelPath.split(/[/\\]/).pop() || modelPath,
                    sourcePath: modelPath,
                });
            }
        }
    }
    return entries;
}
