// public/js/gltf-loader-draco.js
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { DRACO_DECODER_PATH } from './draco-decoder-path.js';

let dracoLoaderSingleton = null;

/**
 * アプリ全体で共有する DRACOLoader（同一 WASM の再読み込みを避ける）
 * @returns {DRACOLoader}
 */
function getDracoLoader() {
    if (!dracoLoaderSingleton) {
        dracoLoaderSingleton = new DRACOLoader();
        dracoLoaderSingleton.setDecoderPath(DRACO_DECODER_PATH);
    }
    return dracoLoaderSingleton;
}

/**
 * Draco 圧縮済み GLB も読み込める GLTFLoader を返す
 * @returns {GLTFLoader}
 */
export function createGLTFLoaderWithDraco() {
    const loader = new GLTFLoader();
    loader.setDRACOLoader(getDracoLoader());
    return loader;
}
