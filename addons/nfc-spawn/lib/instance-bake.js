// addons/nfc-spawn/lib/instance-bake.js — インスタンス型 NFC のベイク（モデル切り出し・マニフェスト生成）
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { STORAGE_PATHS } from '../../../config/storage-paths.js';
import { getWorldModels } from './worlds.js';
import {
    normalizePrefabManifest,
    resolvePrefabPartAssetPath,
    selectModelsInSphere,
} from './sphere-selection.js';

const DEFAULT_MAX_ENTRIES = 50;
const DEFAULT_MAX_BYTES = 100 * 1024 * 1024;
const DEFAULT_MODEL_RADIUS = 5;

/**
 * @param {string} relativePath models/... または plane/...
 * @returns {string|null}
 */
export function resolveModelsFilePath(relativePath) {
    const p = String(relativePath || '').trim().replace(/^\//, '');
    if (!p || p.startsWith('plane/')) return null;
    if (p.startsWith('models/')) {
        return path.join(STORAGE_PATHS.MODELS_DIR, p.slice('models/'.length));
    }
    return path.join(STORAGE_PATHS.MODELS_DIR, p);
}

/**
 * @param {string} manifestPath
 * @returns {object|null}
 */
export function readPrefabManifestSync(manifestPath) {
    const rel = String(manifestPath || '').trim();
    const filePath = resolveModelsFilePath(rel);
    if (!filePath || !fs.existsSync(filePath)) return null;
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
        return null;
    }
}

/**
 * @param {number} spawnId
 */
export function getInstanceDir(spawnId) {
    return path.join(STORAGE_PATHS.NFC_INSTANCES_DIR, String(spawnId));
}

/**
 * @param {string} srcAbs
 * @param {string} destDir
 * @returns {{ relPath: string, bytes: number }}
 */
function copyGlbToInstance(srcAbs, destDir) {
    const hash = createHash('sha256').update(srcAbs).digest('hex').slice(0, 12);
    const base = path.basename(srcAbs, path.extname(srcAbs));
    const destName = `${base}-${hash}.glb`;
    const destAbs = path.join(destDir, destName);
    fs.copyFileSync(srcAbs, destAbs);
    const bytes = fs.statSync(destAbs).size;
    return { relPath: `models/${destName}`, bytes };
}

/**
 * @param {object} config
 * @param {{ x: number, y: number, z: number }} origin
 */
function relativeTrs(config, origin) {
    const pos = config.position || { x: 0, y: 0, z: 0 };
    const rot = config.rotation || { x: 0, y: 0, z: 0 };
    const scale = config.scale || { x: 1, y: 1, z: 1 };
    return {
        position: [pos.x - origin.x, pos.y - origin.y, pos.z - origin.z],
        rotation: [rot.x, rot.y, rot.z],
        scale: [scale.x, scale.y, scale.z],
    };
}

/**
 * @param {object} spawnRow
 * @param {object} [options]
 * @param {Set<number>} [options.excludeModelIndices]
 * @param {object} [config]
 */
export async function previewInstanceBake(spawnRow, options = {}, config = {}) {
    const worldModels = getWorldModels(spawnRow.world_id);
    const center = { x: spawnRow.x, y: spawnRow.y, z: spawnRow.z };
    const radius = Number(spawnRow.load_radius);
    const defaultModelRadius =
        typeof config.defaultModelRadius === 'number' ? config.defaultModelRadius : DEFAULT_MODEL_RADIUS;
    const entries = await selectModelsInSphere({
        worldModels,
        center,
        radius,
        defaultModelRadius,
        loadManifest: async (manifestPath) => readPrefabManifestSync(manifestPath),
        excludeModelIndices: options.excludeModelIndices,
    });
    return { entries, center, radius, worldId: spawnRow.world_id };
}

/**
 * @param {object} spawnRow
 * @param {object} [options]
 * @param {Set<number>} [options.excludeModelIndices]
 * @param {object} bakeConfig
 */
export async function bakeInstance(spawnRow, options = {}, bakeConfig = {}) {
    if (String(spawnRow.type || '') !== 'instance') {
        throw new Error('not_instance_type');
    }
    const maxEntries =
        typeof bakeConfig.maxEntries === 'number' ? bakeConfig.maxEntries : DEFAULT_MAX_ENTRIES;
    const maxBytes = typeof bakeConfig.maxBytes === 'number' ? bakeConfig.maxBytes : DEFAULT_MAX_BYTES;
    const preview = await previewInstanceBake(spawnRow, options, bakeConfig);
    if (!preview.entries.length) {
        throw new Error('no_models_in_sphere');
    }
    if (preview.entries.length > maxEntries) {
        throw new Error('too_many_entries');
    }

    const spawnId = spawnRow.id;
    const instanceDir = getInstanceDir(spawnId);
    const modelsDir = path.join(instanceDir, 'models');
    const prefabsDir = path.join(instanceDir, 'prefabs');
    const tmpDir = `${instanceDir}.tmp`;
    const tmpModels = path.join(tmpDir, 'models');
    const tmpPrefabs = path.join(tmpDir, 'prefabs');
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.mkdirSync(tmpModels, { recursive: true });
    fs.mkdirSync(tmpPrefabs, { recursive: true });

    const origin = { x: spawnRow.x, y: spawnRow.y, z: spawnRow.z };
    const worldModels = getWorldModels(spawnRow.world_id);
    /** @type {object[]} */
    const manifestEntries = [];
    let totalBytes = 0;
    let prefabCounter = 0;

    for (const sel of preview.entries) {
        const config =
            typeof worldModels[sel.worldModelIndex] === 'string'
                ? { path: worldModels[sel.worldModelIndex] }
                : worldModels[sel.worldModelIndex];
        const trs = relativeTrs(config, origin);

        if (sel.entryKind === 'glb' && sel.sourcePath) {
            const src = resolveModelsFilePath(sel.sourcePath);
            if (!src || !fs.existsSync(src)) {
                throw new Error(`missing_glb:${sel.sourcePath}`);
            }
            const copied = copyGlbToInstance(src, tmpModels);
            totalBytes += copied.bytes;
            manifestEntries.push({
                kind: 'glb',
                file: copied.relPath,
                position: trs.position,
                rotation: trs.rotation,
                scale: trs.scale,
                label: sel.label,
            });
            continue;
        }

        if (!sel.prefabManifest) continue;
        const raw = readPrefabManifestSync(sel.prefabManifest);
        if (!raw) throw new Error(`missing_manifest:${sel.prefabManifest}`);
        const man = normalizePrefabManifest(raw);
        const partIndices =
            sel.entryKind === 'prefab_parts' && sel.partIndices?.length
                ? sel.partIndices
                : man.parts.map((_, i) => i);

        const newParts = [];
        for (const pi of partIndices) {
            const part = man.parts[pi];
            if (!part) continue;
            const assetPath = resolvePrefabPartAssetPath(part.file);
            const src = resolveModelsFilePath(assetPath);
            if (!src || !fs.existsSync(src)) {
                throw new Error(`missing_part:${assetPath}`);
            }
            const copied = copyGlbToInstance(src, tmpModels);
            totalBytes += copied.bytes;
            newParts.push({
                file: copied.relPath.replace(/^models\//, ''),
                bounds: part.bounds,
            });
        }
        if (!newParts.length) continue;

        prefabCounter += 1;
        const prefabFileName = `prefab-${prefabCounter}.json`;
        const subManifest = {
            version: 1,
            prefabGroupId: man.prefabGroupId || `instance-${spawnId}-${prefabCounter}`,
            displayName: man.displayName || sel.label,
            bounds: man.bounds,
            parts: newParts,
        };
        fs.writeFileSync(
            path.join(tmpPrefabs, prefabFileName),
            JSON.stringify(subManifest, null, 2),
            'utf8'
        );
        manifestEntries.push({
            kind: 'prefab',
            manifest: `prefabs/${prefabFileName}`,
            position: trs.position,
            rotation: trs.rotation,
            scale: trs.scale,
            label: sel.label,
        });
    }

    if (!manifestEntries.length) throw new Error('no_models_baked');
    if (totalBytes > maxBytes) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
        throw new Error('bake_too_large');
    }

    const revision = (Number(spawnRow.bake_revision) || 0) + 1;
    const manifest = {
        version: 1,
        spawnId,
        label: spawnRow.label,
        bakedAt: new Date().toISOString(),
        bakeRevision: revision,
        sourceWorldId: spawnRow.world_id,
        origin: [origin.x, origin.y, origin.z],
        camera: { position: [0, 1.6, 4], lookAt: [0, 1, 0] },
        entries: manifestEntries,
    };
    fs.writeFileSync(path.join(tmpDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

    fs.rmSync(instanceDir, { recursive: true, force: true });
    fs.renameSync(tmpDir, instanceDir);

    const dbEntries = preview.entries.map((e) => ({
        worldModelIndex: e.worldModelIndex,
        entryKind: e.entryKind,
        prefabManifest: e.prefabManifest || null,
        partIndices: e.partIndices || null,
        sourcePath: e.sourcePath || null,
    }));

    return {
        manifestPath: `${spawnId}/manifest.json`,
        entries: dbEntries,
        totalBytes,
        entryCount: manifestEntries.length,
        bakeRevision: revision,
    };
}

/**
 * @param {number} spawnId
 */
export function deleteInstanceFiles(spawnId) {
    const dir = getInstanceDir(spawnId);
    fs.rmSync(dir, { recursive: true, force: true });
}
