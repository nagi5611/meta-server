// addons/webxr-vr/client/vr-quick-menu-input.js — 左手 Y ボタンエッジ検出

const LEFT_Y_BUTTON_INDEX = 5;

/**
 * 左手 Y ボタンの押下エッジを検出する
 * @param {XRSession|null} session
 * @param {boolean} prevPressed 前フレームの pressed 状態
 * @returns {{ pressed: boolean, edge: boolean }}
 */
export function pollLeftYButtonEdge(session, prevPressed) {
    if (!session) {
        return { pressed: false, edge: false };
    }

    let pressed = false;
    for (const src of session.inputSources) {
        if (src.handedness !== 'left') continue;
        const btn = src.gamepad?.buttons?.[LEFT_Y_BUTTON_INDEX];
        if (btn?.pressed) {
            pressed = true;
            break;
        }
    }

    return {
        pressed,
        edge: pressed && !prevPressed,
    };
}
