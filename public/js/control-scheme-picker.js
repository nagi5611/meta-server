/**
 * control-scheme-picker.js - 初回の操作方式（タッチ / キーボード）選択 UI
 */

import { applyMetaverseI18nToDocument } from './metaverse-i18n.js';
import {
    CONTROL_SCHEME_KEYBOARD,
    CONTROL_SCHEME_TOUCH,
    prefersTouchInput,
    setControlScheme,
} from './mobile-utils.js';

/**
 * 操作方式選択オーバーレイを表示し、選択結果を返す
 * @returns {Promise<'touch'|'keyboard'>}
 */
export function showControlSchemePicker() {
    return new Promise((resolve) => {
        const existing = document.getElementById('control-scheme-overlay');
        if (existing) existing.remove();

        const recommendTouch = prefersTouchInput();
        const overlay = document.createElement('div');
        overlay.id = 'control-scheme-overlay';
        overlay.className = 'control-scheme-overlay';
        overlay.setAttribute('role', 'dialog');
        overlay.setAttribute('aria-modal', 'true');
        overlay.setAttribute('aria-labelledby', 'control-scheme-title');

        overlay.innerHTML = `
            <div class="control-scheme-dialog">
                <h2 id="control-scheme-title" data-i18n="controlScheme.title">操作方法を選んでください</h2>
                <p class="control-scheme-desc" data-i18n="controlScheme.desc">あとから設定の「一般」で変更できます</p>
                <div class="control-scheme-actions">
                    <button type="button" class="control-scheme-btn" data-scheme="touch" id="control-scheme-touch-btn">
                        <span class="control-scheme-btn-label" data-i18n="controlScheme.touch">タッチ操作</span>
                        <span class="control-scheme-btn-hint" data-i18n="controlScheme.touchHint">仮想スティックで移動</span>
                        <span class="control-scheme-recommend" data-i18n="controlScheme.recommended" hidden>おすすめ</span>
                    </button>
                    <button type="button" class="control-scheme-btn" data-scheme="keyboard" id="control-scheme-keyboard-btn">
                        <span class="control-scheme-btn-label" data-i18n="controlScheme.keyboard">キーボード操作</span>
                        <span class="control-scheme-btn-hint" data-i18n="controlScheme.keyboardHint">WASD とマウスで操作</span>
                        <span class="control-scheme-recommend" data-i18n="controlScheme.recommended" hidden>おすすめ</span>
                    </button>
                </div>
            </div>
        `;

        document.body.appendChild(overlay);
        applyMetaverseI18nToDocument();

        const touchBtn = overlay.querySelector('#control-scheme-touch-btn');
        const keyboardBtn = overlay.querySelector('#control-scheme-keyboard-btn');
        const recommendEl = recommendTouch
            ? touchBtn?.querySelector('.control-scheme-recommend')
            : keyboardBtn?.querySelector('.control-scheme-recommend');
        if (recommendEl) recommendEl.hidden = false;

        const finish = (scheme) => {
            setControlScheme(scheme);
            overlay.remove();
            resolve(scheme);
        };

        touchBtn?.addEventListener('click', () => finish(CONTROL_SCHEME_TOUCH));
        keyboardBtn?.addEventListener('click', () => finish(CONTROL_SCHEME_KEYBOARD));

        (recommendTouch ? touchBtn : keyboardBtn)?.focus();
    });
}
