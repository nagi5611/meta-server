// addons/smoke-view/play_vdb/js/shader-settings.js — シェーダー設定の定義と GPU バッファ書き込み

/** @typedef {{
 *   exposure: number,
 *   gamma: number,
 *   smokeRoughness: number,
 *   smokeDenseMix: number,
 *   smokeColor: [number, number, number],
 *   smokeDarkenMult: number,
 *   smokeBrightness: number,
 *   fogDensity: number,
 *   fogStart: number,
 *   sunElevationDeg: number,
 *   sunAzimuthDeg: number,
 *   turbidity: number,
 *   groundRoughness: number,
 *   groundMetallic: number,
 *   debugHeatmap: boolean,
 * }} ShaderSettings */

export const RENDER_SETTINGS_BYTE_LENGTH = 80;

/** @returns {ShaderSettings} */
export function createDefaultShaderSettings() {
    return {
        exposure: 0.1,
        gamma: 2.2,
        smokeRoughness: 0.92,
        smokeDenseMix: 0.55,
        smokeColor: [0.08, 0.08, 0.08],
        smokeDarkenMult: 0.28,
        smokeBrightness: 1.4,
        fogDensity: 0.01,
        fogStart: 10,
        sunElevationDeg: 60,
        sunAzimuthDeg: 0,
        turbidity: 2,
        groundRoughness: 1,
        groundMetallic: 1,
        debugHeatmap: false,
    };
}

/**
 * @typedef {{
 *   key: keyof ShaderSettings,
 *   label: string,
 *   min: number,
 *   max: number,
 *   step: number,
 *   group: string,
 * }} ShaderSliderDef
 */

/** @type {ShaderSliderDef[]} */
export const SHADER_SLIDER_DEFS = [
    { group: 'トーン', key: 'exposure', label: '露出', min: 0.01, max: 1, step: 0.01 },
    { group: 'トーン', key: 'gamma', label: 'ガンマ', min: 1, max: 3, step: 0.05 },
    { group: '煙マテリアル', key: 'smokeColor', label: 'R', min: 0, max: 1, step: 0.01 },
    { group: '煙マテリアル', key: 'smokeColorG', label: 'G', min: 0, max: 1, step: 0.01 },
    { group: '煙マテリアル', key: 'smokeColorB', label: 'B', min: 0, max: 1, step: 0.01 },
    { group: '煙マテリアル', key: 'smokeRoughness', label: 'ラフネス', min: 0, max: 1, step: 0.01 },
    { group: '煙マテリアル', key: 'smokeDenseMix', label: '濃さミックス', min: 0, max: 1, step: 0.01 },
    { group: '煙マテリアル', key: 'smokeDarkenMult', label: '暗さ係数', min: 0, max: 1, step: 0.01 },
    { group: '煙マテリアル', key: 'smokeBrightness', label: '明るさ', min: 0.1, max: 3, step: 0.05 },
    { group: '大気', key: 'fogStart', label: 'フォグ開始距離', min: 0, max: 50, step: 0.5 },
    { group: '大気', key: 'fogDensity', label: 'フォグ密度', min: 0, max: 0.1, step: 0.001 },
    { group: '大気', key: 'sunElevationDeg', label: '太陽高度 (°)', min: 0, max: 90, step: 1 },
    { group: '大気', key: 'sunAzimuthDeg', label: '太陽方位 (°)', min: -180, max: 180, step: 1 },
    { group: '大気', key: 'turbidity', label: '濁度', min: 1, max: 10, step: 0.1 },
    { group: '地面', key: 'groundRoughness', label: 'ラフネス', min: 0, max: 1, step: 0.01 },
    { group: '地面', key: 'groundMetallic', label: 'メタリック', min: 0, max: 1, step: 0.01 },
];

/**
 * @param {ArrayBuffer} buffer
 * @param {ShaderSettings} settings
 */
export function writeRenderSettingsBuffer(buffer, settings) {
    const f32 = new Float32Array(buffer);
    const u32 = new Uint32Array(buffer);
    f32[0] = settings.exposure;
    f32[1] = settings.gamma;
    f32[2] = settings.smokeRoughness;
    f32[3] = settings.smokeDenseMix;
    f32[4] = settings.smokeColor[0];
    f32[5] = settings.smokeColor[1];
    f32[6] = settings.smokeColor[2];
    f32[7] = settings.smokeDarkenMult;
    f32[8] = settings.smokeBrightness;
    f32[9] = settings.fogDensity;
    f32[10] = settings.fogStart;
    f32[11] = (settings.sunElevationDeg * Math.PI) / 180;
    f32[12] = (settings.sunAzimuthDeg * Math.PI) / 180;
    f32[13] = settings.turbidity;
    f32[14] = settings.groundRoughness;
    f32[15] = settings.groundMetallic;
    u32[16] = settings.debugHeatmap ? 1 : 0;
    u32[17] = 0;
}

/**
 * @param {number} sunElevationDeg
 * @param {number} sunAzimuthDeg
 * @returns {[number, number, number]}
 */
export function sunDirectionFromDegrees(sunElevationDeg, sunAzimuthDeg) {
    const elevation = (sunElevationDeg * Math.PI) / 180;
    const azimuth = (sunAzimuthDeg * Math.PI) / 180;
    const sunZenith = 0.5 * Math.PI - elevation;
    return [
        Math.sin(sunZenith) * Math.cos(azimuth),
        Math.cos(sunZenith),
        -Math.sin(sunZenith) * Math.sin(azimuth),
    ];
}
