// addons/smoke-view/play_vdb/js/shader-controls.js — シェーダー設定スライダー UI
import {
    createDefaultShaderSettings,
    SHADER_SLIDER_DEFS,
    snapMsaaSamples,
} from './shader-settings.js';

/**
 * @param {HTMLElement} container
 * @param {{
 *   getSettings: () => import('./shader-settings.js').ShaderSettings,
 *   setSettings: (partial: Partial<import('./shader-settings.js').ShaderSettings>) => void,
 * }} api
 */
export function createShaderControls(container, api) {
    const defaults = createDefaultShaderSettings();
    /** @type {Map<string, HTMLInputElement>} */
    const inputs = new Map();

    const resetBtn = document.createElement('button');
    resetBtn.type = 'button';
    resetBtn.className = 'play-vdb-btn play-vdb-btn-small';
    resetBtn.textContent = '設定リセット';
    resetBtn.addEventListener('click', () => {
        api.setSettings({
            ...defaults,
            smokeColor: [...defaults.smokeColor],
        });
        syncUIFromSettings();
    });
    container.appendChild(resetBtn);

    const heatmapLabel = document.createElement('label');
    heatmapLabel.className = 'play-vdb-check';
    const heatmapInput = document.createElement('input');
    heatmapInput.type = 'checkbox';
    heatmapInput.addEventListener('change', () => {
        api.setSettings({ debugHeatmap: heatmapInput.checked });
    });
    heatmapLabel.appendChild(heatmapInput);
    heatmapLabel.append(' HDDA イテレーション表示');
    container.appendChild(heatmapLabel);
    inputs.set('debugHeatmap', heatmapInput);

    const taaLabel = document.createElement('label');
    taaLabel.className = 'play-vdb-check';
    const taaInput = document.createElement('input');
    taaInput.type = 'checkbox';
    taaInput.addEventListener('change', () => {
        api.setSettings({ taaEnabled: taaInput.checked });
    });
    taaLabel.appendChild(taaInput);
    taaLabel.append(' TAA 有効');
    container.appendChild(taaLabel);
    inputs.set('taaEnabled', taaInput);

    let currentGroup = '';
    let groupEl = null;

    for (const def of SHADER_SLIDER_DEFS) {
        if (def.group !== currentGroup) {
            currentGroup = def.group;
            groupEl = document.createElement('div');
            groupEl.className = 'play-vdb-shader-group';
            const title = document.createElement('h3');
            title.className = 'play-vdb-shader-group-title';
            title.textContent = def.group;
            groupEl.appendChild(title);
            container.appendChild(groupEl);
        }

        const row = document.createElement('div');
        row.className = 'play-vdb-slider-row';

        const label = document.createElement('label');
        label.className = 'play-vdb-slider-label';
        label.textContent = def.label;

        const slider = document.createElement('input');
        slider.type = 'range';
        slider.min = String(def.min);
        slider.max = String(def.max);
        slider.step = String(def.step);
        slider.className = 'play-vdb-slider';

        const valueEl = document.createElement('span');
        valueEl.className = 'play-vdb-slider-value';

        const key = def.key;
        slider.addEventListener('input', () => {
            const v = Number(slider.value);
            valueEl.textContent = formatValue(v, def.step);
            if (key === 'smokeColorG') {
                const s = api.getSettings();
                api.setSettings({ smokeColor: [s.smokeColor[0], v, s.smokeColor[2]] });
            } else if (key === 'smokeColorB') {
                const s = api.getSettings();
                api.setSettings({ smokeColor: [s.smokeColor[0], s.smokeColor[1], v] });
            } else if (key === 'smokeColor') {
                const s = api.getSettings();
                api.setSettings({ smokeColor: [v, s.smokeColor[1], s.smokeColor[2]] });
            } else if (key === 'msaaSamples') {
                const snapped = snapMsaaSamples(v);
                slider.value = String(snapped);
                valueEl.textContent = String(snapped);
                api.setSettings({ msaaSamples: snapped });
            } else {
                api.setSettings({ [key]: v });
            }
        });

        inputs.set(key, slider);
        row.append(label, slider, valueEl);
        groupEl.appendChild(row);
    }

    /**
     * @param {number} v
     * @param {number} step
     */
    function formatValue(v, step) {
        const decimals = step < 0.01 ? 3 : step < 0.1 ? 2 : step < 1 ? 1 : 0;
        return v.toFixed(decimals);
    }

    function syncUIFromSettings() {
        const s = api.getSettings();
        for (const def of SHADER_SLIDER_DEFS) {
            const slider = inputs.get(def.key);
            if (!slider) continue;
            let v;
            if (def.key === 'smokeColor') v = s.smokeColor[0];
            else if (def.key === 'smokeColorG') v = s.smokeColor[1];
            else if (def.key === 'smokeColorB') v = s.smokeColor[2];
            else if (def.key === 'msaaSamples') v = snapMsaaSamples(s.msaaSamples);
            else v = s[def.key];
            slider.value = String(v);
            const valueEl = slider.parentElement?.querySelector('.play-vdb-slider-value');
            if (valueEl) valueEl.textContent = formatValue(v, def.step);
        }
        const heatmap = inputs.get('debugHeatmap');
        if (heatmap) heatmap.checked = s.debugHeatmap;
        const taa = inputs.get('taaEnabled');
        if (taa) taa.checked = s.taaEnabled;
    }

    syncUIFromSettings();

    return { syncUIFromSettings };
}
