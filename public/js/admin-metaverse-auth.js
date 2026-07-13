// public/js/admin-metaverse-auth.js — /admin 入室用ワンタイムトークン取得
import { t } from './metaverse-i18n.js';

/**
 * 管理者カメラログインの URL か
 * @returns {boolean}
 */
export function isAdminCameraEntryPath() {
    const p = window.location.pathname;
    return p === '/admin/camera' || p === '/admin/camera/';
}

/**
 * 管理者用メタバースの URL か（/admin・カメラログイン）
 * @returns {boolean}
 */
export function isAdminMetaverseEntryPath() {
    const p = window.location.pathname;
    return p === '/admin' || p === '/admin/' || isAdminCameraEntryPath();
}

/**
 * Basic 認証済みセッションで Socket 用ワンタイムトークンを取得する
 * @returns {Promise<{ token: string, username: string, mode?: string } | null>}
 */
export async function fetchAdminMetaverseEntry() {
    try {
        const camera = isAdminCameraEntryPath();
        const url = camera ? '/admin/enter-metaverse?mode=camera' : '/admin/enter-metaverse';
        const res = await fetch(url, { credentials: 'include' });
        if (!res.ok) return null;
        const data = await res.json();
        const token = String(data?.token || '').trim();
        const username = String(data?.username || '').trim();
        if (!token) return null;
        return {
            token,
            username: username || (camera ? 'Guest0000' : 'admin'),
            mode: data?.mode || (camera ? 'camera' : 'default'),
        };
    } catch (err) {
        console.error('Admin metaverse auth failed:', err);
        return null;
    }
}

/** Basic 認証なし等で管理者メタバース入室できないときに管理画面へ戻す */
export function redirectAdminMetaverseAuthFailed() {
    alert(t('main.needBasicAuth'));
    window.location.href = '/admin.html' + window.location.search + window.location.hash;
}
