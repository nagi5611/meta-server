// public/js/mesh-bvh-worker-client.js — BVH 構築をブラウザ Web Worker で非同期実行

import { MeshBVH } from 'three-mesh-bvh';
import { GenerateMeshBVHWorker } from 'three-mesh-bvh/worker';

/** @type {GenerateMeshBVHWorker | null} */
let workerSingleton = null;
/** Worker 生成が一度でも失敗したらメインスレッドにフォールバック */
let workerDisabled = false;

/**
 * 共有 GenerateMeshBVHWorker を返す（初回のみ生成）
 * @returns {GenerateMeshBVHWorker}
 */
function getMeshBvhWorker() {
    if (workerDisabled) {
        return null;
    }
    if (!workerSingleton) {
        try {
            workerSingleton = new GenerateMeshBVHWorker();
        } catch (err) {
            workerDisabled = true;
            console.warn('[mesh-bvh-worker] Worker init failed, using main thread:', err);
            return null;
        }
    }
    return workerSingleton;
}

/**
 * メインスレッドで boundsTree を構築する（フォールバック）
 * @param {import('three').BufferGeometry} geometry
 * @param {object} options
 * @returns {import('three-mesh-bvh').MeshBVH}
 */
function buildMeshBVHSync(geometry, options) {
    const bvh = new MeshBVH(geometry, options);
    geometry.boundsTree = bvh;
    return bvh;
}

/** scene-manager と同一の BVH 構築オプション */
export const MESH_BVH_BUILD_OPTIONS = {
    strategy: 0,
    maxDepth: 40,
    maxLeafTris: 10,
    verbose: false,
};

/**
 * Worker で geometry に boundsTree を構築する
 * @param {import('three').BufferGeometry} geometry
 * @param {object} [options]
 * @returns {Promise<import('three-mesh-bvh').MeshBVH>}
 */
export async function buildMeshBVHAsync(geometry, options = MESH_BVH_BUILD_OPTIONS) {
    const worker = getMeshBvhWorker();
    if (!worker) {
        return buildMeshBVHSync(geometry, options);
    }
    try {
        const bvh = await worker.generate(geometry, options);
        if (!geometry.boundsTree) {
            geometry.boundsTree = bvh;
        }
        return bvh;
    } catch (err) {
        console.warn('[mesh-bvh-worker] Worker generate failed, using main thread:', err);
        workerDisabled = true;
        if (workerSingleton) {
            workerSingleton.dispose();
            workerSingleton = null;
        }
        return buildMeshBVHSync(geometry, options);
    }
}

/**
 * Worker が実行中か
 * @returns {boolean}
 */
export function isMeshBvhWorkerRunning() {
    return workerSingleton?.running === true;
}

/**
 * Worker を終了する（通常はアプリ終了時のみ）
 */
export function disposeMeshBvhWorker() {
    if (workerSingleton) {
        workerSingleton.dispose();
        workerSingleton = null;
    }
}
