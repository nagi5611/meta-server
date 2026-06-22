// public/pre_xr/js/input-monitor.js — DOM パネル更新・イベントログ

import { formatInputSources } from './input-utils.js';

const MAX_EVENTS = 40;

/**
 * XR デバッグ用 DOM パネルを更新する。
 */
export class InputMonitor {
    /**
     * @param {object} els
     * @param {HTMLElement} els.statusText
     * @param {HTMLElement} els.inputSources
     * @param {HTMLElement} els.locoState
     * @param {HTMLOListElement} els.eventLog
     * @param {HTMLElement} [els.fps]
     */
    constructor({ statusText, inputSources, locoState, eventLog, fps = null }) {
        this.statusText = statusText;
        this.inputSources = inputSources;
        this.locoState = locoState;
        this.eventLog = eventLog;
        this.fpsEl = fps;
        this._frameCount = 0;
        this._fpsTimer = 0;
        this._lastFps = 0;
    }

    /**
     * @param {string} msg
     */
    logEvent(msg) {
        const li = document.createElement('li');
        const t = new Date();
        const ts = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}:${String(t.getSeconds()).padStart(2, '0')}`;
        li.textContent = `[${ts}] ${msg}`;
        this.eventLog.prepend(li);
        while (this.eventLog.children.length > MAX_EVENTS) {
            this.eventLog.removeChild(this.eventLog.lastElementChild);
        }
    }

    /**
     * @param {number} deltaTime
     */
    tickFps(deltaTime) {
        if (!this.fpsEl) return;
        this._frameCount += 1;
        this._fpsTimer += deltaTime;
        if (this._fpsTimer >= 0.5) {
            this._lastFps = Math.round(this._frameCount / this._fpsTimer);
            this._frameCount = 0;
            this._fpsTimer = 0;
            this.fpsEl.textContent = `FPS ${this._lastFps}`;
        }
    }

    /**
     * @param {object} state
     */
    updateStatus(state) {
        const lines = [
            `WebXR: ${state.webxrSupported ? '対応' : '非対応'}`,
            `没入中: ${state.presenting ? 'はい' : 'いいえ'}`,
            `参照空間: ${state.refSpace || '—'}`,
            `入力ソース数: ${state.inputSourceCount}`,
            `リグ位置: ${state.rigPos || '—'}`,
            `リグヨー: ${state.rigYawDeg || '—'}°`,
            `カメラ位置: ${state.camPos || '—'}`
        ];
        this.statusText.textContent = lines.join('\n');
    }

    /**
     * @param {XRInputSource[]} allSources
     */
    updateInputPanel(allSources) {
        this.inputSources.textContent = formatInputSources(allSources || []);
    }

    /**
     * @param {object} loco
     */
    updateLocoPanel(loco) {
        const lines = [
            `モード: ${loco.mode}`,
            `移動 vec: x=${loco.moveX.toFixed(2)} y=${loco.moveY.toFixed(2)} mag=${loco.moveMag.toFixed(2)}`,
            `スナップ X: ${loco.snapX.toFixed(2)}`,
            `左グリップ: ${loco.leftGrip ? 'ON' : 'off'}`,
            `左手 Y[5]: ${loco.leftY ? 'ON' : 'off'}`,
            `押下ボタン: ${loco.ySummary || '—'}`,
            `軸ペア: [${loco.axisTag}] raw=${loco.rawHypot.toFixed(2)}`,
            `gamepad付きソース: ${loco.hasMoveGamepad ? 'あり' : 'なし'}`
        ];
        this.locoState.textContent = lines.join('\n');
    }
}
