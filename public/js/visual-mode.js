// public/js/visual-mode.js — 描画方法（標準 / ハイコントラスト）の 3D・DOM 適用

/** @typedef {'standard'|'highContrast'} VisualMode */

export const VISUAL_MODE_STANDARD = 'standard';
export const VISUAL_MODE_HIGH_CONTRAST = 'highContrast';

/** HC 時の露出オフセット（ユーザー設定値に加算、上限 2.0） */
export const HC_EXPOSURE_OFFSET = 0.3;

const SCENE_BG_STANDARD = 0x87ceeb;
const SCENE_BG_HC = 0xffffff;

const GROUND_COLOR_STANDARD = 0x4a7c59;
const GROUND_COLOR_HC = 0x1a1a1a;

const GRID_COLOR1_STANDARD = 0x000000;
const GRID_COLOR2_STANDARD = 0x2a4a2a;
const GRID_COLOR1_HC = 0xffffff;
const GRID_COLOR2_HC = 0x888888;

/** @type {Record<VisualMode, { zenith: number, horizon: number, groundColor: number, midSky: number }>} */
const SKY_UNIFORM_PRESETS = {
    standard: {
        zenith: 0x1e90ff,
        horizon: 0xf5f5f5,
        groundColor: 0x666666,
        midSky: 0x9acbff
    },
    highContrast: {
        zenith: 0xffffff,
        horizon: 0xe8e8e8,
        groundColor: 0x333333,
        midSky: 0xf5f5f5
    }
};

/**
 * @param {unknown} v
 * @returns {VisualMode}
 */
export function normalizeVisualMode(v) {
    if (v === VISUAL_MODE_HIGH_CONTRAST) return VISUAL_MODE_HIGH_CONTRAST;
    return VISUAL_MODE_STANDARD;
}

/**
 * @param {VisualMode} mode
 */
export function setVisualModeOnDocument(mode) {
    const m = normalizeVisualMode(mode);
    const root = document.documentElement;
    if (m === VISUAL_MODE_HIGH_CONTRAST) {
        root.setAttribute('data-visual-mode', VISUAL_MODE_HIGH_CONTRAST);
    } else {
        root.removeAttribute('data-visual-mode');
    }
}

/**
 * @param {import('three').Object3D} obj
 * @returns {boolean}
 */
function shouldSkipObject(obj) {
    if (!obj) return true;
    const n = obj.name || '';
    if (n === 'SkyDome' || n === 'ViewRangeDebug') return true;
    if (obj.userData?.editorPreview) return true;
    return false;
}

/**
 * @param {import('three').Color} color
 * @param {typeof import('three')} THREE
 * @returns {import('three').Color}
 */
function boostContrastColor(color, THREE) {
    const hsl = { h: 0, s: 0, l: 0 };
    color.getHSL(hsl);
    const l = hsl.l;
    const targetL = l < 0.45 ? Math.max(0, l - 0.22) : Math.min(1, l + 0.22);
    const out = color.clone();
    out.setHSL(hsl.h, Math.min(1, hsl.s * 1.05), targetL);
    return out;
}

/**
 * @param {import('three').Material} mat
 */
function backupMaterial(mat) {
    if (!mat || mat.userData._visualModeBackup) return;
    const b = {};
    if ('color' in mat && mat.color) {
        b.color = mat.color.clone();
    }
    if ('emissive' in mat && mat.emissive) {
        b.emissive = mat.emissive.clone();
    }
    if ('emissiveIntensity' in mat) {
        b.emissiveIntensity = mat.emissiveIntensity;
    }
    if ('metalness' in mat) {
        b.metalness = mat.metalness;
    }
    if ('roughness' in mat) {
        b.roughness = mat.roughness;
    }
    mat.userData._visualModeBackup = b;
}

/**
 * @param {import('three').Material} mat
 */
function restoreMaterial(mat) {
    const b = mat?.userData?._visualModeBackup;
    if (!b || !mat) return;
    if (b.color && 'color' in mat) mat.color.copy(b.color);
    if (b.emissive && 'emissive' in mat) mat.emissive.copy(b.emissive);
    if (b.emissiveIntensity !== undefined && 'emissiveIntensity' in mat) {
        mat.emissiveIntensity = b.emissiveIntensity;
    }
    if (b.metalness !== undefined && 'metalness' in mat) mat.metalness = b.metalness;
    if (b.roughness !== undefined && 'roughness' in mat) mat.roughness = b.roughness;
    delete mat.userData._visualModeBackup;
    mat.needsUpdate = true;
}

/**
 * @param {import('three').Material} mat
 * @param {typeof import('three')} THREE
 */
function applyHighContrastMaterial(mat, THREE) {
    if (!mat || mat.isShaderMaterial) return;
    const alreadyHc = !!mat.userData._visualModeBackup;
    backupMaterial(mat);
    if (alreadyHc) return;
    if ('metalness' in mat) mat.metalness = 0;
    if ('roughness' in mat) mat.roughness = 1;
    if ('color' in mat && mat.color) {
        mat.color.copy(boostContrastColor(mat.color, THREE));
    }
    if ('emissive' in mat && mat.color) {
        if (!mat.emissive) mat.emissive = new THREE.Color();
        mat.emissive.copy(mat.color);
        mat.emissive.multiplyScalar(0.15);
    }
    if ('emissiveIntensity' in mat) {
        mat.emissiveIntensity = Math.max(mat.emissiveIntensity || 0, 0.12);
    }
    mat.needsUpdate = true;
}

/**
 * @param {import('three').Object3D} root
 * @param {VisualMode} mode
 * @param {typeof import('three')} THREE
 */
export function applyVisualModeToObject3D(root, mode, THREE) {
    if (!root) return;
    const hc = normalizeVisualMode(mode) === VISUAL_MODE_HIGH_CONTRAST;
    root.traverse((obj) => {
        if (shouldSkipObject(obj)) return;
        if (!obj.isMesh && !obj.isSkinnedMesh) return;
        const materials = Array.isArray(obj.material) ? obj.material : [obj.material];
        for (const mat of materials) {
            if (!mat) continue;
            if (hc) {
                applyHighContrastMaterial(mat, THREE);
            } else {
                restoreMaterial(mat);
            }
        }
        if (obj.isMesh && obj.userData.pdfPath) {
            updatePdfOutline(obj, mode, THREE);
        }
    });
}

/**
 * @param {import('three').Mesh|null|undefined} skyMesh
 * @param {VisualMode} mode
 * @param {typeof import('three')} THREE
 */
export function applySkyDomeUniforms(skyMesh, mode, THREE) {
    if (!skyMesh?.material?.uniforms) return;
    const preset = SKY_UNIFORM_PRESETS[normalizeVisualMode(mode)];
    const u = skyMesh.material.uniforms;
    if (u.zenithColor) u.zenithColor.value.setHex(preset.zenith);
    if (u.horizonColor) u.horizonColor.value.setHex(preset.horizon);
    if (u.groundColor) u.groundColor.value.setHex(preset.groundColor);
    if (u.midSkyColor) u.midSkyColor.value.setHex(preset.midSky);
}

/**
 * @param {import('three').Scene} scene
 * @param {VisualMode} mode
 * @param {typeof import('three')} THREE
 */
export function applySceneBackground(scene, mode, THREE) {
    if (!scene) return;
    const hex = normalizeVisualMode(mode) === VISUAL_MODE_HIGH_CONTRAST ? SCENE_BG_HC : SCENE_BG_STANDARD;
    scene.background = new THREE.Color(hex);
}

/**
 * @param {{ groundMesh?: import('three').Mesh|null, gridHelper?: import('three').GridHelper|null }} env
 * @param {VisualMode} mode
 * @param {typeof import('three')} THREE
 */
export function applyEnvironmentVisuals(env, mode, THREE) {
    const hc = normalizeVisualMode(mode) === VISUAL_MODE_HIGH_CONTRAST;
    const { groundMesh, gridHelper } = env;
    if (groundMesh?.material && 'color' in groundMesh.material) {
        const mat = groundMesh.material;
        if (hc) {
            backupMaterial(mat);
            mat.color.setHex(GROUND_COLOR_HC);
            mat.metalness = 0;
            mat.roughness = 1;
        } else if (mat.userData._visualModeBackup) {
            restoreMaterial(mat);
        } else {
            mat.color.setHex(GROUND_COLOR_STANDARD);
        }
        mat.needsUpdate = true;
    }
    if (gridHelper?.material) {
        const mats = Array.isArray(gridHelper.material) ? gridHelper.material : [gridHelper.material];
        mats.forEach((mat, i) => {
            if (!mat || !('color' in mat)) return;
            if (hc) {
                backupMaterial(mat);
                mat.color.setHex(i === 0 ? GRID_COLOR1_HC : GRID_COLOR2_HC);
            } else if (mat.userData._visualModeBackup) {
                restoreMaterial(mat);
            } else {
                mat.color.setHex(i === 0 ? GRID_COLOR1_STANDARD : GRID_COLOR2_STANDARD);
            }
        });
    }
}

/**
 * @param {import('three').Light[]} worldLights
 * @param {VisualMode} mode
 */
export function applyWorldLightsVisual(worldLights, mode) {
    const hc = normalizeVisualMode(mode) === VISUAL_MODE_HIGH_CONTRAST;
    for (const light of worldLights) {
        if (!light) continue;
        if (hc) {
            if (!light.userData._visualModeLightBackup) {
                light.userData._visualModeLightBackup = {
                    intensity: light.intensity,
                    castShadow: !!light.castShadow
                };
            }
            const base = light.userData._visualModeLightBackup.intensity;
            if (light.isAmbientLight) {
                light.intensity = base * 1.35;
            } else if (light.isDirectionalLight) {
                light.intensity = base * 0.5;
                light.castShadow = false;
            } else {
                light.intensity = base * 0.75;
                if ('castShadow' in light) light.castShadow = false;
            }
        } else if (light.userData._visualModeLightBackup) {
            const b = light.userData._visualModeLightBackup;
            light.intensity = b.intensity;
            if ('castShadow' in light) light.castShadow = b.castShadow;
            delete light.userData._visualModeLightBackup;
        }
    }
}

/**
 * @param {import('three').Mesh} mesh
 * @param {VisualMode} mode
 * @param {typeof import('three')} THREE
 */
export function updatePdfOutline(mesh, mode, THREE) {
    if (!mesh?.isMesh) return;
    const hc = normalizeVisualMode(mode) === VISUAL_MODE_HIGH_CONTRAST;
    const existing = mesh.userData.pdfOutline;
    if (!hc) {
        if (existing) {
            mesh.remove(existing);
            if (existing.geometry) existing.geometry.dispose();
            if (existing.material) existing.material.dispose();
            delete mesh.userData.pdfOutline;
        }
        return;
    }
    if (existing) return;
    const sx = mesh.scale.x || 1;
    const sy = mesh.scale.y || 1;
    const pad = 0.06;
    const geom = new THREE.PlaneGeometry(1 + pad / sx, 1 + pad / sy);
    const edges = new THREE.EdgesGeometry(geom);
    geom.dispose();
    const lineMat = new THREE.LineBasicMaterial({ color: 0x000000, depthTest: true });
    const outline = new THREE.LineSegments(edges, lineMat);
    outline.position.z = -0.02;
    outline.renderOrder = mesh.renderOrder + 1;
    outline.userData.isPdfOutline = true;
    mesh.add(outline);
    mesh.userData.pdfOutline = outline;
}

/**
 * HC 時の実効露出
 * @param {number} baseExposure
 * @param {VisualMode} mode
 * @returns {number}
 */
export function getEffectiveToneMappingExposure(baseExposure, mode) {
    const base = typeof baseExposure === 'number' && Number.isFinite(baseExposure) ? baseExposure : 1;
    if (normalizeVisualMode(mode) === VISUAL_MODE_HIGH_CONTRAST) {
        return Math.min(2, base + HC_EXPOSURE_OFFSET);
    }
    return base;
}

/**
 * SceneManager 向け一括適用（露出は呼び出し側で getEffectiveToneMappingExposure を使う）
 * @param {object} sceneManager
 * @param {typeof import('three')} THREE
 */
export function applyVisualModeToSceneManager(sceneManager, THREE) {
    if (!sceneManager) return;
    const mode = normalizeVisualMode(sceneManager.graphicsOptions?.visualMode);
    setVisualModeOnDocument(mode);
    const hc = mode === VISUAL_MODE_HIGH_CONTRAST;

    applySceneBackground(sceneManager.scene, mode, THREE);
    applySkyDomeUniforms(sceneManager._skyDomeMesh, mode, THREE);
    applyEnvironmentVisuals(
        { groundMesh: sceneManager.groundMesh, gridHelper: sceneManager.gridHelper },
        mode,
        THREE
    );
    applyWorldLightsVisual(sceneManager.worldLights || [], mode);

    if (sceneManager.renderer) {
        sceneManager.renderer.shadowMap.enabled = !hc;
    }

    if (sceneManager.environmentGroup) {
        applyVisualModeToObject3D(sceneManager.environmentGroup, mode, THREE);
    }
}
