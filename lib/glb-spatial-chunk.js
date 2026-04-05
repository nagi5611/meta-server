// lib/glb-spatial-chunk.js — アップロード GLB をシーン直下ノードの空間グループで分割し複数 chunk GLB + manifest を出力
import fs from 'fs';
import path from 'path';
import { cloneDocument, prune, getBounds } from '@gltf-transform/functions';
import { getGltfTransformIO } from './glb-texture-resize.js';

/** このバイト数未満はチャンク分割しない */
export const SPATIAL_CHUNK_MIN_BYTES = 2 * 1024 * 1024;

/** 空間セルサイズ（glTF 座標系。1 単位 ≒ 1m と仮定） */
export const SPATIAL_CHUNK_CELL_SIZE = 32;

/**
 * テクスチャ縮小済み GLB を条件が揃えばチャンク化する。
 * @param {Buffer} buffer
 * @param {{ modelsDir: string, baseFilename: string }} options
 * @returns {Promise<{ applied: boolean, manifestRelativePath?: string, chunkFiles?: string[], reason?: string, detail?: string }>}
 */
export async function runGlbSpatialChunkIfNeeded(buffer, options) {
    const { modelsDir, baseFilename } = options;
    if (!Buffer.isBuffer(buffer) || buffer.length < SPATIAL_CHUNK_MIN_BYTES) {
        return { applied: false, reason: 'below_size_threshold' };
    }
    const ext = path.extname(baseFilename).toLowerCase();
    if (ext !== '.glb') {
        return { applied: false, reason: 'not_glb' };
    }
    const basename = path.basename(baseFilename, ext);

    let srcDoc;
    try {
        const io = await getGltfTransformIO();
        const view = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
        srcDoc = await io.readBinary(view);
    } catch (e) {
        return { applied: false, reason: 'read_failed', detail: e instanceof Error ? e.message : String(e) };
    }

    const root = srcDoc.getRoot();
    const scenes = root.listScenes();
    if (!scenes.length) {
        return { applied: false, reason: 'no_scene' };
    }

    const scene = scenes[0];
    const origChildren = scene.listChildren();
    if (origChildren.length < 2) {
        return { applied: false, reason: 'need_multiple_root_nodes' };
    }

    const cellSize = SPATIAL_CHUNK_CELL_SIZE;
    /** @type {Map<string, number[]>} */
    const groups = new Map();
    for (let i = 0; i < origChildren.length; i++) {
        const child = origChildren[i];
        let min;
        let max;
        try {
            ({ min, max } = getBounds(child));
        } catch {
            min = [0, 0, 0];
            max = [0, 0, 0];
        }
        const cx = (min[0] + max[0]) / 2;
        const cy = (min[1] + max[1]) / 2;
        const cz = (min[2] + max[2]) / 2;
        const key = `${Math.floor(cx / cellSize)},${Math.floor(cy / cellSize)},${Math.floor(cz / cellSize)}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(i);
    }

    if (groups.size < 2) {
        return { applied: false, reason: 'all_in_one_cell' };
    }

    const io = await getGltfTransformIO();
    /** @type {{ file: string, center: number[], radius: number }[]} */
    const chunks = [];
    let chunkIndex = 0;
    const chunkFiles = [];

    for (const indices of groups.values()) {
        const doc = cloneDocument(srcDoc);
        const s = doc.getRoot().listScenes()[0];
        const children = [...s.listChildren()];
        for (let i = 0; i < children.length; i++) {
            if (!indices.includes(i)) {
                const n = children[i];
                s.removeChild(n);
                n.dispose();
            }
        }
        await doc.transform(prune());

        const chunkName = `${basename}.chunk_${chunkIndex}.glb`;
        const chunkPath = path.join(modelsDir, chunkName);
        const outBin = await io.writeBinary(doc);
        fs.writeFileSync(chunkPath, Buffer.from(outBin));
        chunkFiles.push(chunkName);

        const sb = getBounds(s);
        const dx = sb.max[0] - sb.min[0];
        const dy = sb.max[1] - sb.min[1];
        const dz = sb.max[2] - sb.min[2];
        const ccx = (sb.min[0] + sb.max[0]) / 2;
        const ccy = (sb.min[1] + sb.max[1]) / 2;
        const ccz = (sb.min[2] + sb.max[2]) / 2;
        const radius = 0.5 * Math.sqrt(dx * dx + dy * dy + dz * dz);
        chunks.push({
            file: `models/${chunkName}`,
            center: [ccx, ccy, ccz],
            radius: Math.max(radius, 0.01)
        });
        chunkIndex++;
    }

    const manifestName = `${basename}.chunks.json`;
    const manifestPath = path.join(modelsDir, manifestName);
    const manifest = {
        version: 1,
        cellSize,
        baseName: basename,
        chunks
    };
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

    return {
        applied: true,
        manifestRelativePath: `models/${manifestName}`,
        chunkFiles: [manifestName, ...chunkFiles]
    };
}
