// addons/qr-ar/client/ar/model-loader.js — GLB ロード（Draco 対応）
import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js';
import { GLTFLoader } from 'https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/loaders/DRACOLoader.js';

const DRACO_DECODER_PATH = 'https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/libs/draco/';

let dracoLoader = null;
let gltfLoader = null;

/**
 * Draco 付き GLTFLoader を返す
 */
function getLoader() {
    if (!gltfLoader) {
        dracoLoader = new DRACOLoader();
        dracoLoader.setDecoderPath(DRACO_DECODER_PATH);
        gltfLoader = new GLTFLoader();
        gltfLoader.setDRACOLoader(dracoLoader);
    }
    return gltfLoader;
}

/**
 * GLB をロードしてグループを返す
 * @param {string} url
 * @returns {Promise<THREE.Group>}
 */
export async function loadGlbModel(url) {
    const loader = getLoader();
    const gltf = await loader.loadAsync(url);
    const root = gltf.scene || new THREE.Group();
    root.traverse((obj) => {
        if (obj.isMesh) {
            obj.castShadow = false;
            obj.receiveShadow = false;
        }
    });
    return root;
}

/**
 * @param {THREE.Object3D} obj
 */
export function disposeObject3D(obj) {
    obj.traverse((child) => {
        if (child.isMesh) {
            child.geometry?.dispose?.();
            const mats = child.material
                ? Array.isArray(child.material)
                    ? child.material
                    : [child.material]
                : [];
            for (const m of mats) {
                m.dispose?.();
            }
        }
    });
}
