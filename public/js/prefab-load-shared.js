// public/js/prefab-load-shared.js — prefab マニフェスト fetch + THREE.Group + 子 GLB 読込（scene-manager / setting 共有）

import { countTrianglesInObject } from './model-load-limits.js';
import { resolveModelAssetHref } from './asset-resolve.js';

/**
 * マニフェスト parts[].file を models/ または plane/ 付きの参照パスへ正規化
 * @param {string} file
 * @returns {string}
 */
export function resolvePrefabPartAssetPath(file) {
    const f = String(file || '').trim().replace(/^\//, '');
    if (!f) return f;
    if (f.startsWith('models/') || f.startsWith('plane/')) return f;
    return `models/${f}`;
}

/** マニフェスト内 .glb パーツの同時取得数（1 本の GLTFLoader は setPath 競合のためパーツごとに作る） */
const PREFAB_PART_LOAD_CONCURRENCY = 24;

/**
 * 工場を最大 concurrency 本で同時実行し、結果を入力順の配列で返す
 * @template T
 * @param {number} concurrency
 * @param {Array<() => Promise<T>>} factories
 * @returns {Promise<T[]>}
 */
async function runWithConcurrency(concurrency, factories) {
    const n = factories.length;
    const results = new Array(n);
    let cursor = 0;
    async function worker() {
        while (true) {
            const i = cursor++;
            if (i >= n) break;
            results[i] = await factories[i]();
        }
    }
    const workers = Math.min(Math.max(1, concurrency), Math.max(1, n));
    await Promise.all(Array.from({ length: workers }, () => worker()));
    return results;
}

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
 * plane/ で始まるパスを /admin/plane-asset 配下の URL に写す（管理 Basic 配下で取得）
 * @param {string} planeRelativePath 例 plane/foo-prefab-manifest.json
 * @param {string} adminBase 例 /admin/plane-asset
 * @returns {string}
 */
export function adminPlaneProxyUrl(planeRelativePath, adminBase) {
    const p = String(planeRelativePath || '').trim().replace(/^\//, '');
    const base = String(adminBase || '').replace(/\/+$/, '');
    if (!base || !p.startsWith('plane/')) return '';
    return `${base}/${p.slice('plane/'.length)}`;
}

/**
 * マニフェスト URL から JSON を取得
 * @param {string} manifestPath
 * @param {{ adminPlaneProxyBase?: string }} [opts] adminPlaneProxyBase 指定時、plane/ パスは /admin/plane-asset 経由（Basic 配下）
 * @returns {Promise<object>}
 */
export async function fetchPrefabManifestJson(manifestPath, opts = {}) {
    const rawPath = String(manifestPath || '').trim();
    const proxyBase = String(opts.adminPlaneProxyBase || '').trim();
    let u;
    if (proxyBase && rawPath.startsWith('plane/')) {
        u = adminPlaneProxyUrl(rawPath, proxyBase);
        if (!u) {
            u = await resolveModelAssetHref(rawPath);
        }
    } else {
        u = await resolveModelAssetHref(rawPath);
    }
    let credentials = 'omit';
    if (typeof window !== 'undefined') {
        try {
            const abs = u.startsWith('http://') || u.startsWith('https://')
                ? new URL(u)
                : new URL(u, window.location.origin);
            if (abs.origin === window.location.origin) {
                credentials = 'include';
            }
        } catch {
            credentials = 'omit';
        }
    }
    const mRes = await fetch(u, { credentials });
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
 * マニフェストに従い子 GLB を読み、同一 Group にまとめる。各パーツ GLB のネットワーク取得は最大 16 本まで並行（GLTFLoader はパーツごとに生成）。
 * @param {object} options
 * @param {typeof import('three')} options.THREE
 * @param {import('three').Group} [options.existingGroup] 再読込用に既存 Group を流用
 * @param {string} options.manifestPath models/ から始まるマニフェスト相対パス
 * @param {() => import('three/examples/jsm/loaders/GLTFLoader.js').GLTFLoader} options.createGLTFLoader
 * @param {(name: string, xhr: ProgressEvent, partIndex: number, partCount: number) => void} [options.onXhrProgress]
 * @param {string} [options.adminPlaneProxyBase] 指定時、plane/ で始まるマニフェスト・パーツは /admin/plane-asset 経由で取得（管理画面 Basic）
 * @returns {Promise<{ group: import('three').Group, manifest: ReturnType<typeof normalizePrefabManifest>, totalTris: number }>}
 */
export async function loadPrefabGroupFromManifest({
    THREE,
    existingGroup,
    manifestPath,
    createGLTFLoader,
    onXhrProgress,
    adminPlaneProxyBase,
}) {
    const raw = await fetchPrefabManifestJson(manifestPath, { adminPlaneProxyBase });
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
    const partCount = man.parts.length;
    const factories = man.parts.map((p, i) => async () => {
        const filePath = resolvePrefabPartAssetPath(p.file);
        let resolved;
        if (adminPlaneProxyBase && filePath.startsWith('plane/')) {
            const proxied = adminPlaneProxyUrl(filePath, adminPlaneProxyBase);
            resolved = proxied || (await resolveModelAssetHref(filePath));
        } else {
            resolved = await resolveModelAssetHref(filePath);
        }
        return new Promise((resolve, reject) => {
            const loader = createGLTFLoader();
            const isHttpsAbs = /^https:\/\//i.test(resolved);
            const onProg = /** @type {import('three').LoadingManager['onProgress']} */ ((xhr) => {
                const label = resolved.split(/[/]/).pop() || resolved;
                onXhrProgress?.(label, xhr, i, partCount);
            });
            if (isHttpsAbs) {
                loader.load(
                    resolved,
                    (gltf) => {
                        const root = gltf.scene;
                        const anims = Array.isArray(gltf.animations) ? gltf.animations : [];
                        if (anims.length) root.userData.gltfClips = anims;
                        root.userData.prefabGroupId = man.prefabGroupId;
                        root.userData.prefabPartPath = filePath;
                        root.userData.isPrefabPart = true;
                        resolve(root);
                    },
                    onProg,
                    reject
                );
                return;
            }
            const { dirUrl, fileName } = gltfLoaderPathAndFile(resolved);
            loader.setPath(dirUrl);
            loader.load(
                fileName,
                (gltf) => {
                    const root = gltf.scene;
                    const anims = Array.isArray(gltf.animations) ? gltf.animations : [];
                    if (anims.length) root.userData.gltfClips = anims;
                    root.userData.prefabGroupId = man.prefabGroupId;
                    root.userData.prefabPartPath = filePath;
                    root.userData.isPrefabPart = true;
                    resolve(root);
                },
                onProg,
                reject
            );
        });
    });
    const partRoots = await runWithConcurrency(PREFAB_PART_LOAD_CONCURRENCY, factories);
    let totalTris = 0;
    for (const scene of partRoots) {
        group.add(scene);
        totalTris += countTrianglesInObject(scene);
    }
    return { group, manifest: man, totalTris };
}
