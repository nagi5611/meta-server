// public/js/mesh-bvh-worker-client.js — BVH 構築をブラウザ Web Worker で非同期実行

import { GenerateMeshBVHWorker } from 'three-mesh-bvh/worker';

/** @type {GenerateMeshBVHWorker | null} */
let workerSingleton = null;

/**
 * 共有 GenerateMeshBVHWorker を返す（初回のみ生成）
 * @returns {GenerateMeshBVHWorker}
 */
function getMeshBvhWorker() {
    if (!workerSingleton) {
        workerSingleton = new GenerateMeshBVHWorker();
    }
    return workerSingleton;
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
    return worker.generate(geometry, options);
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
