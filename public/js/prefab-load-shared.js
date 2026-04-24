// public/js/prefab-load-shared.js — prefab マニフェスト fetch + THREE.Group + 子 GLB 読込（scene-manager / setting 共有）

import { countTrianglesInObject } from './model-load-limits.js';

/**
 * @param {string} assetPath models/ からの相対（例: models/Foo_prefab/a.glb または Foo_prefab/a.glb）
 * @returns {string} 同一オリジン URL
 */
export function buildEncodedModelUrlFromPath(assetPath) {
    const pathStr = String(assetPath || '').replace(/^\//, '');
    const encodedPath = pathStr.split('/').map((seg) => encodeURIComponent(seg)).join('/');
    return '/' + encodedPath;
}

/**
 * @param {object} manifest
 * @returns {{ version: number, prefabGroupId: string, displayName: string, parts: { file: string }[] }}
 */
export function normalizePrefabManifest(manifest) {
    const v = manifest && typeof manifest === 'object' ? manifest : {};
    const parts = Array.isArray(v.parts) ? v.parts : [];
    return {
        version: typeof v.version === 'number' ? v.version : 1,
        prefabGroupId: String(v.prefabGroupId || '').trim(),
        displayName: String(v.displayName || '').trim() || 'prefab',
        parts: parts
            .map((p) => ({ file: String(p?.file || '').replace(/^\//, '').trim() }))
            .filter((p) => p.file.toLowerCase().endsWith('.glb'))
    };
}

/**
 * マニフェスト URL から JSON を取得
 * @param {string} manifestPath
 * @returns {Promise<object>}
 */
export async function fetchPrefabManifestJson(manifestPath) {
    const u = buildEncodedModelUrlFromPath(manifestPath);
    const mRes = await fetch(u);
    if (!mRes.ok) {
        throw new Error(`マニフェストの取得に失敗: ${manifestPath}（HTTP ${mRes.status}）`);
    }
    return mRes.json();
}

/**
 * @param {string} fullUrl 例 /models/Foo_prefab/a.glb
 * @returns {{ dirUrl: string, fileName: string }}
 */
export function gltfLoaderPathAndFile(fullUrl) {
    const last = fullUrl.lastIndexOf('/');
    if (last < 0) {
        return { dirUrl: '/', fileName: fullUrl.replace(/^\//, '') };
    }
    return {
        dirUrl: fullUrl.slice(0, last + 1),
        fileName: fullUrl.slice(last + 1)
    };
}

/**
 * @param {object} options
 * @param {typeof import('three')} options.THREE
 * @param {import('three').Group} [options.existingGroup] 再読込用に既存 Group を流用
 * @param {string} options.manifestPath models/ から始まるマニフェスト相対パス
 * @param {() => import('three/examples/jsm/loaders/GLTFLoader.js').GLTFLoader} options.createGLTFLoader
 * @param {(name: string, xhr: ProgressEvent, partIndex: number, partCount: number) => void} [options.onXhrProgress]
 * @returns {Promise<{ group: import('three').Group, manifest: ReturnType<typeof normalizePrefabManifest>, totalTris: number }>}
 */
export async function loadPrefabGroupFromManifest({ THREE, existingGroup, manifestPath, createGLTFLoader, onXhrProgress }) {
    const raw = await fetchPrefabManifestJson(manifestPath);
    const man = normalizePrefabManifest(raw);
    if (!man.parts.length) {
        throw new Error('prefab マニフェストに .glb パーツがありません');
    }
    const group = existingGroup && existingGroup.isGroup ? existingGroup : new THREE.Group();
    while (group.children.length) {
        const c = group.children[0];
        group.remove(c);
    }
    group.userData.prefabDisplayName = man.displayName;
    group.userData.prefabGroupId = man.prefabGroupId;
    const loader = createGLTFLoader();
    const partCount = man.parts.length;
    let totalTris = 0;
    for (let i = 0; i < man.parts.length; i++) {
        const p = man.parts[i];
        const filePath = p.file.startsWith('models/') ? p.file : `models/${p.file}`;
        const fullPathUrl = buildEncodedModelUrlFromPath(filePath);
        const { dirUrl, fileName } = gltfLoaderPathAndFile(fullPathUrl);
        loader.setPath(dirUrl);
        const scene = await new Promise((resolve, reject) => {
            loader.load(
                fileName,
                (gltf) => {
                    const root = gltf.scene;
                    const anims = Array.isArray(gltf.animations) ? gltf.animations : [];
                    if (anims.length) root.userData.gltfClips = anims;
                    resolve(root);
                },
                (xhr) => onXhrProgress?.(fileName, xhr, i, partCount),
                reject
            );
        });
        scene.userData.prefabGroupId = man.prefabGroupId;
        scene.userData.prefabPartPath = filePath;
        scene.userData.isPrefabPart = true;
        group.add(scene);
        totalTris += countTrianglesInObject(scene);
    }
    return { group, manifest: man, totalTris };
}
