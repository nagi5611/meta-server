// public/js/metaverse-client-settings.js — クライアント設定の読み取り（localStorage）

const SETTINGS_KEY = 'metaverse-settings';

/**
 * 保存済みメタバース設定を読み取る
 * @returns {Record<string, unknown>}
 */
export function readMetaverseClientSettings() {
    try {
        const saved = localStorage.getItem(SETTINGS_KEY);
        if (!saved) return {};
        const parsed = JSON.parse(saved);
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
        return {};
    }
}

/**
 * 開発者モード（ロード詳細表示など）が有効か
 * @returns {boolean}
 */
export function isDeveloperModeEnabled() {
    return !!readMetaverseClientSettings().developerMode;
}
