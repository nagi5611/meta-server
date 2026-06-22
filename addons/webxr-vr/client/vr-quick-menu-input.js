// addons/webxr-vr/client/vr-quick-menu-input.js — 左手 Y ボタンエッジ検出

const LEFT_Y_BUTTON_INDEX = 5;

/**
 * 全入力ソースのボタン押下状況を調査（pre_xr / デバッグ用）
 * @param {XRSession|null} session
 * @returns {{ leftY: boolean, pressedIndices: { source: number, handedness: string, index: number }[], summary: string }}
 */
export function inspectYButton(session) {
    /** @type {{ source: number, handedness: string, index: number }[]} */
    const pressedIndices = [];
    let leftY = false;

    if (!session) {
        return { leftY: false, pressedIndices, summary: 'sessionなし' };
    }

    for (let si = 0; si < session.inputSources.length; si++) {
        const src = session.inputSources[si];
        const buttons = src.gamepad?.buttons;
        if (!buttons) continue;
        for (let bi = 0; bi < buttons.length; bi++) {
            if (!buttons[bi]?.pressed) continue;
            pressedIndices.push({
                source: si,
                handedness: src.handedness || '?',
                index: bi,
            });
            if (src.handedness === 'left' && bi === LEFT_Y_BUTTON_INDEX) {
                leftY = true;
            }
        }
    }

    const summary = pressedIndices.length
        ? pressedIndices.map((p) => `#${p.source} ${p.handedness} [${p.index}]`).join(', ')
        : '押下なし';

    return { leftY, pressedIndices, summary };
}

/**
 * 左手 Y ボタンの押下エッジを検出する
 * @param {XRSession|null} session
 * @param {boolean} prevPressed 前フレームの pressed 状態
 * @returns {{ pressed: boolean, edge: boolean, detail: string }}
 */
export function pollLeftYButtonEdge(session, prevPressed) {
    if (!session) {
        return { pressed: false, edge: false, detail: 'no-session' };
    }

    let pressed = false;
    let detail = 'none';

    for (const src of session.inputSources) {
        if (src.handedness !== 'left') continue;
        const btn = src.gamepad?.buttons?.[LEFT_Y_BUTTON_INDEX];
        if (btn?.pressed) {
            pressed = true;
            detail = 'left[5]';
            break;
        }
    }

    // handedness 未設定時: 左手とみなしやすい先頭ソースの [5]
    if (!pressed) {
        for (const src of session.inputSources) {
            if (src.handedness === 'right') continue;
            const btn = src.gamepad?.buttons?.[LEFT_Y_BUTTON_INDEX];
            if (btn?.pressed) {
                pressed = true;
                detail = `fallback-${src.handedness || '?' }[5]`;
                break;
            }
        }
    }

    return {
        pressed,
        edge: pressed && !prevPressed,
        detail,
    };
}
