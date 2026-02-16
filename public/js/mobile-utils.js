/**
 * mobile-utils.js - モバイル端末判定と全画面・横画面ユーティリティ
 */

const MOBILE_BREAKPOINT_WIDTH = 768;
const MOBILE_BREAKPOINT_HEIGHT = 600;

/**
 * 768px以下をスマホとする（横画面時は高さで判定）
 * 横画面スマホは width>768 になるため、幅 OR 高さのいずれかが閾値以下でモバイルとみなす
 * @returns {boolean}
 */
export function isMobile() {
    return window.innerWidth <= MOBILE_BREAKPOINT_WIDTH ||
        window.innerHeight <= MOBILE_BREAKPOINT_HEIGHT;
}

/**
 * 全画面モードをリクエスト（ユーザージェスチャー内で呼ぶこと）
 * @returns {Promise<boolean>} 成功可否
 */
export async function setupFullscreen() {
    const doc = document.documentElement;
    try {
        if (!document.fullscreenElement) {
            await doc.requestFullscreen();
            return true;
        }
        return true;
    } catch (err) {
        console.warn('[mobile-utils] Fullscreen failed:', err);
        return false;
    }
}

/**
 * 横画面ロックを試行（全画面時のみ有効、iOS Safari は未対応）
 * @returns {Promise<boolean>} 成功可否
 */
export async function tryLockLandscape() {
    if (!screen?.orientation?.lock) return false;
    try {
        await screen.orientation.lock('landscape');
        return true;
    } catch (err) {
        console.warn('[mobile-utils] Orientation lock failed:', err);
        return false;
    }
}

/**
 * 768px境界でモバイル/PC切替時にコールバック実行
 * @param {(isMobile: boolean) => void} callback
 * @returns {() => void} 解除関数
 */
export function onResize(callback) {
    let wasMobile = isMobile();
    callback(wasMobile);

    const handler = () => {
        const nowMobile = isMobile();
        if (nowMobile !== wasMobile) {
            wasMobile = nowMobile;
            callback(nowMobile);
        }
    };

    window.addEventListener('resize', handler);
    return () => window.removeEventListener('resize', handler);
}
