// public/js/ibl-setup.js — THREE 注入型（Vite バンドルと admin の importmap の両方から利用）

/** 既定の IBL 用 HDR（運用で public/env に配置。リポジトリにはバイナリを含めない） */
export const DEFAULT_HDR_PATH = '/env/default.hdr';

/** [scene-manager] addWorldLights 既定 ambient と揃える */
export const DEFAULT_WORLD_AMBIENT_INTENSITY = 0.6;

/** [scene-manager] addWorldLights 既定 directional と揃える */
export const DEFAULT_WORLD_DIRECTIONAL_INTENSITY = 0.8;

/** @typedef {'high'|'medium'|'low'} GraphicsTier */

const TIER_PRESETS = {
    high: { mapSize: 2048, shadowMapType: 'PCFSoft', antialias: true },
    medium: { mapSize: 1024, shadowMapType: 'PCFSoft', antialias: true },
    low: { mapSize: 512, shadowMapType: 'Basic', antialias: false }
};

/**
 * ティア文字列を正規化する
 * @param {string|undefined} tier
 * @returns {GraphicsTier}
 */
export function normalizeGraphicsTier(tier) {
    if (tier === 'high' || tier === 'medium' || tier === 'low') return tier;
    return 'medium';
}

/**
 * @param {typeof import('three')} THREE
 * @param {GraphicsTier} tier
 * @returns {number}
 */
export function getShadowMapTypeConstant(THREE, tier) {
    const name = TIER_PRESETS[normalizeGraphicsTier(tier)].shadowMapType;
    return name === 'Basic' ? THREE.BasicShadowMap : THREE.PCFSoftShadowMap;
}

/**
 * @param {GraphicsTier} tier
 * @returns {number}
 */
export function getShadowMapSize(tier) {
    return TIER_PRESETS[normalizeGraphicsTier(tier)].mapSize;
}

/**
 * @param {GraphicsTier} tier
 * @returns {boolean}
 */
export function getAntialiasForTier(tier) {
    return TIER_PRESETS[normalizeGraphicsTier(tier)].antialias;
}

/**
 * localStorage 由来のオブジェクトを新スキーマに寄せる（旧 drawQualityLow / shadowQuality / fogFar を除去）
 * @param {Record<string, unknown>} raw
 * @returns {{ graphicsTier: GraphicsTier, toneMappingExposure: number, pixelRatioCap: number|'full' }}
 */
export function migrateLegacyGraphicsKeys(raw) {
    const s = { ...raw };
    let graphicsTier = s.graphicsTier;
    if (graphicsTier !== 'high' && graphicsTier !== 'medium' && graphicsTier !== 'low') {
        if (s.drawQualityLow === true) {
            graphicsTier = 'low';
        } else if (s.shadowQuality === 'highest' || s.shadowQuality === 'high' || s.shadowQuality === 'normal') {
            graphicsTier = 'high';
        } else if (s.shadowQuality === 'medium') {
            graphicsTier = 'medium';
        } else if (s.shadowQuality === 'low') {
            graphicsTier = 'low';
        } else {
            graphicsTier = 'medium';
        }
    }
    let toneMappingExposure = Number(s.toneMappingExposure);
    if (!Number.isFinite(toneMappingExposure)) toneMappingExposure = 1;
    toneMappingExposure = Math.min(2, Math.max(0.3, toneMappingExposure));

    let pixelRatioCap = s.pixelRatioCap;
    if (pixelRatioCap !== 'full' && pixelRatioCap !== 1 && pixelRatioCap !== 2) {
        pixelRatioCap = 1;
    }

    return {
        graphicsTier: normalizeGraphicsTier(String(graphicsTier)),
        toneMappingExposure,
        pixelRatioCap
    };
}

/**
 * PMREM ターゲットと scene.environment を破棄する
 * @param {import('three').Scene} scene
 */
export function disposeSceneIBL(scene) {
    const rt = scene.userData.iblPmremTarget;
    if (rt) {
        rt.dispose();
        delete scene.userData.iblPmremTarget;
    }
    scene.environment = null;
}

/**
 * ACES Filmic と露出を適用する
 * @param {typeof import('three')} THREE
 * @param {import('three').WebGLRenderer} renderer
 * @param {number} exposure
 */
export function applyToneMapping(THREE, renderer, exposure) {
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = typeof exposure === 'number' && Number.isFinite(exposure) ? exposure : 1;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
}

/**
 * HDR を読み込み scene.environment に PMREM を設定する（scene.background は変更しない）
 * @param {typeof import('three')} THREE
 * @param {{ scene: import('three').Scene, renderer: import('three').WebGLRenderer, RGBELoader: new () => import('three/examples/jsm/loaders/RGBELoader.js').RGBELoader, PMREMGenerator: new (r: import('three').WebGLRenderer) => import('three/examples/jsm/utils/PMREMGenerator.js').PMREMGenerator }} deps
 * @param {{ hdrUrl?: string }} [options]
 * @returns {Promise<{ ok: boolean, error?: unknown }>}
 */
export function loadSceneIBL(THREE, deps, options = {}) {
    const { scene, renderer, RGBELoader, PMREMGenerator } = deps;
    const hdrUrl = options.hdrUrl || DEFAULT_HDR_PATH;

    disposeSceneIBL(scene);

    return new Promise((resolve) => {
        const loader = new RGBELoader();
        loader.load(
            hdrUrl,
            (texture) => {
                try {
                    texture.mapping = THREE.EquirectangularReflectionMapping;
                    const pmrem = new PMREMGenerator(renderer);
                    const rt = pmrem.fromEquirectangular(texture);
                    texture.dispose();
                    pmrem.dispose();
                    scene.environment = rt.texture;
                    scene.userData.iblPmremTarget = rt;
                    resolve({ ok: true });
                } catch (err) {
                    console.warn('[ibl-setup] PMREM failed:', err);
                    resolve({ ok: false, error: err });
                }
            },
            undefined,
            (err) => {
                console.warn('[ibl-setup] HDR load failed:', hdrUrl, err);
                resolve({ ok: false, error: err });
            }
        );
    });
}

/**
 * メタバースと同じグラデーションスカイドーム（反射には使わない）
 * @param {typeof import('three')} THREE
 * @returns {import('three').Mesh}
 */
export function createGradientSkyDomeMesh(THREE) {
    const radius = 2000;
    const geometry = new THREE.SphereGeometry(radius, 32, 16);

    const vertexShader = `
        varying vec3 vWorldPosition;
        void main() {
            vec4 worldPosition = modelMatrix * vec4(position, 1.0);
            vWorldPosition = worldPosition.xyz;
            gl_Position = projectionMatrix * viewMatrix * worldPosition;
        }
    `;

    const fragmentShader = `
        precision mediump float;
        varying vec3 vWorldPosition;
        uniform vec3 zenithColor;
        uniform vec3 horizonColor;
        uniform vec3 groundColor;
        uniform vec3 midSkyColor;

        void main() {
            float h = vWorldPosition.y;
            float tLow = clamp(h / 920.0, 0.0, 1.0);
            vec3 skyLow = mix(horizonColor, midSkyColor, tLow);
            float tHigh = smoothstep(400.0, 800.0, h);
            vec3 sky = mix(skyLow, zenithColor, tHigh);
            float blend = smoothstep(-80.0, 0.0, h);
            vec3 color = mix(groundColor, sky, blend);
            gl_FragColor = vec4(color, 1.0);
        }
    `;

    const material = new THREE.ShaderMaterial({
        uniforms: {
            zenithColor: { value: new THREE.Color(0x1e90ff) },
            horizonColor: { value: new THREE.Color(0xf5f5f5) },
            groundColor: { value: new THREE.Color(0x666666) },
            midSkyColor: { value: new THREE.Color(0x9acbff) }
        },
        vertexShader,
        fragmentShader,
        side: THREE.BackSide,
        depthWrite: false,
        fog: false
    });

    const skyDome = new THREE.Mesh(geometry, material);
    skyDome.name = 'SkyDome';
    return skyDome;
}
