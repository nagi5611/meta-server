// public/js/admin-metaverse-auth.js — /admin 入室用ワンタイムトークン取得
import { t } from './metaverse-i18n.js';

/**
 * 管理者用メタバースの URL か（/admin または /admin/）
 * @returns {boolean}
 */
export function isAdminMetaverseEntryPath() {
    const p = window.location.pathname;
    return p === '/admin' || p === '/admin/';
}

/**
 * Basic 認証済みセッションで Socket 用ワンタイムトークンを取得する
 * @returns {Promise<{ token: string, username: string } | null>}
 */
export async function fetchAdminMetaverseEntry() {
    try {
        const res = await fetch('/admin/enter-metaverse', { credentials: 'include' });
        if (!res.ok) return null;
        const data = await res.json();
        const token = String(data?.token || '').trim();
        const username = String(data?.username || '').trim();
        if (!token) return null;
        return { token, username: username || 'admin' };
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
