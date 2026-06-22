// addons/webxr-vr/client/vr-controller-utils.js — WebXR コントローラー識別

/**
 * 右手コントローラーの Three.js インデックスを返す
 * @param {{ xr: { getController: (i: number) => { inputSource?: { handedness?: string }|null } } }} renderer
 * @returns {number}
 */
export function resolveRightControllerIndex(renderer) {
    for (let i = 0; i < 2; i++) {
        const src = renderer.xr.getController(i).inputSource;
        if (src?.handedness === 'right') return i;
    }
    return 0;
}
