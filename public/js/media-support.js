/**
 * media-support.js - マイク/カメラ利用可否の検出とユーザー向けメッセージ
 * iPhoneで「ホームに追加」から開いた場合、getUserMedia が使えない WebKit の制限に対応する案内を返す。
 */

/** iOS でホーム画面追加（スタンドアロン）から開いているか */
export function isIosStandalone() {
    if (typeof window === 'undefined') return false;
    if (window.navigator?.standalone === true) return true;
    try {
        return window.matchMedia('(display-mode: standalone)').matches;
    } catch (_) {
        return false;
    }
}

/** マイクが利用できない場合のユーザー向け説明文を返す。利用可能なら null */
export function getMediaUnavailableMessage() {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices) {
        return (
            'マイクを利用できません。' +
            'iPhoneで「ホームに追加」から開いている場合は、SafariでこのページのURLを開き直すと利用できる場合があります。'
        );
    }
    return null;
}

/** getUserMedia 失敗時に iOS ホーム追加の案内を付加したメッセージを返す */
export function getMediaErrorMessage(error, defaultMessage) {
    const base = defaultMessage || 'マイクの利用に失敗しました。';
    if (isIosStandalone()) {
        return base + ' iPhoneでホームに追加したアプリから開いている場合は、Safariでこのページを開き直してみてください。';
    }
    return base;
}
