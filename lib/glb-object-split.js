// lib/glb-object-split.js — GLB を既定シーン直下の複数ルート、または単一親の複数子に分割して複数 GLB を保存
import fs from 'fs';
import path from 'path';
import { cloneDocument, prune } from '@gltf-transform/functions';
import { getGltfTransformIO } from './glb-texture-resize.js';

/**
 * ファイル名に使えない文字を除去・短縮する。
 * @param {string} name
 * @param {number} [maxLen]
 * @returns {string}
 */
function sanitizeFilenameSegment(name, maxLen = 28) {
    const s = String(name || '')
        .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
        .replace(/^\.+/g, '')
        .trim()
        .slice(0, maxLen);
    return s || '';
}

/**
 * 同一ベース名の既存 objsplit パート GLB を列挙する（大文字小文字は区別しない比較）。
 * @param {string} modelsDir
 * @param {string} baseNoExt — 拡張子なし（例: house）
 * @returns {string[]}
 */
export function listObjectSplitFilesForBase(modelsDir, baseNoExt) {
    const prefix = `${String(baseNoExt || '').toLowerCase()}.objsplit_`;
    if (!fs.existsSync(modelsDir)) return [];
    return fs.readdirSync(modelsDir).filter((n) => {
        const nl = n.toLowerCase();
        return nl.startsWith(prefix) && nl.endsWith('.glb');
    });
}

/**
 * 既定シーンを複数パートに分割して各 GLB を modelsDir に書き込む。
 * 2 パーツ以上のときのみ applied:true（1 パーツに縮退しない）。
 * @param {Buffer} buffer
 * @param {{ modelsDir: string, baseFilename: string }} options
 * @returns {Promise<{ applied: boolean, partFiles?: string[], reason?: string, detail?: string }>}
 */
export async function runGlbObjectSplitFromBuffer(buffer, options) {
    const { modelsDir, baseFilename } = options;
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
        return { applied: false, reason: 'empty_buffer' };
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
        return {
            applied: false,
            reason: 'read_failed',
            detail: e instanceof Error ? e.message : String(e),
        };
    }

    const root = srcDoc.getRoot();
    const scenes = root.listScenes();
    if (!scenes.length) {
        return { applied: false, reason: 'no_scene' };
    }

    const scene0 = scenes[0];
    const roots = scene0.listChildren();
    /** @type {'roots'|'nested'|null} */
    let mode = null;
    let partCount = 0;
    if (roots.length >= 2) {
        mode = 'roots';
        partCount = roots.length;
    } else if (roots.length === 1) {
        const nested = roots[0].listChildren();
        if (nested.length >= 2) {
            mode = 'nested';
            partCount = nested.length;
        }
    }

    if (!mode || partCount < 2) {
        return { applied: false, reason: 'unsuitable_scene' };
    }

    const io = await getGltfTransformIO();
    /** @type {string[]} */
    const partFiles = [];

    for (let keepIndex = 0; keepIndex < partCount; keepIndex++) {
        const doc = cloneDocument(srcDoc);
        const s = doc.getRoot().listScenes()[0];
        const sceneRoots = [...s.listChildren()];

        if (mode === 'roots') {
            const children = [...s.listChildren()];
            for (let i = 0; i < children.length; i++) {
                if (i !== keepIndex) {
                    const n = children[i];
                    s.removeChild(n);
                    n.dispose();
                }
            }
        } else {
            const p = sceneRoots[0];
            const pChildren = [...p.listChildren()];
            for (let i = 0; i < pChildren.length; i++) {
                if (i !== keepIndex) {
                    const n = pChildren[i];
                    p.removeChild(n);
                    n.dispose();
                }
            }
        }

        await doc.transform(prune());

        let slug = '';
        if (mode === 'roots') {
            const kept = s.listChildren()[0];
            slug = sanitizeFilenameSegment(kept?.getName?.() || '');
        } else {
            const p = s.listChildren()[0];
            const kept = p?.listChildren?.()?.[0];
            slug = sanitizeFilenameSegment(kept?.getName?.() || '');
        }

        const slugPart = slug ? `_${slug}` : '';
        const partName = `${basename}.objsplit_${keepIndex}${slugPart}.glb`;
        const partPath = path.join(modelsDir, partName);
        const outBin = await io.writeBinary(doc);
        fs.writeFileSync(partPath, Buffer.from(outBin));
        partFiles.push(partName);
    }

    return { applied: true, partFiles };
}
