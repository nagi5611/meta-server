// public/js/world-quality-lod-modal.js — 品質 LOD 選択ポップアップ

import { getQualityLodKeys, formatQualityLodButtonLabel } from './world-quality-lod.js';
import { t } from './metaverse-i18n.js';

/** @type {((key: string|null) => void)|null} */
let pendingResolve = null;

/**
 * 品質 LOD 選択モーダルを閉じる
 * @param {string|null} result
 */
function finishQualityLodModal(result) {
    const modal = document.getElementById('quality-lod-modal');
    if (modal) {
        modal.classList.remove('visible');
        modal.setAttribute('aria-hidden', 'true');
    }
    const resolve = pendingResolve;
    pendingResolve = null;
    if (resolve) resolve(result);
}

/**
 * 品質 LOD 選択モーダルのイベントを一度だけ登録
 */
function bindQualityLodModalEvents() {
    const modal = document.getElementById('quality-lod-modal');
    if (!modal || modal.dataset.bound === '1') return;
    modal.dataset.bound = '1';

    modal.addEventListener('click', (e) => {
        if (e.target === modal) finishQualityLodModal(null);
    });

    document.getElementById('quality-lod-modal-cancel')?.addEventListener('click', () => {
        finishQualityLodModal(null);
    });
}

/**
 * 品質 LOD 選択ポップアップを表示する
 * @param {Record<string, unknown>} world
 * @returns {Promise<string|null>} 選択された LOD キー、キャンセル時 null
 */
export function promptQualityLodChoice(world) {
    bindQualityLodModalEvents();

    const keys = getQualityLodKeys(world);
    if (keys.length < 2) {
        return Promise.resolve(keys.length === 1 ? keys[0] : null);
    }

    const modal = document.getElementById('quality-lod-modal');
    const titleEl = document.getElementById('quality-lod-modal-title');
    const bodyEl = document.getElementById('quality-lod-modal-body');
    const listEl = document.getElementById('quality-lod-modal-options');
    if (!modal || !titleEl || !bodyEl || !listEl) {
        return Promise.resolve(keys[0] || null);
    }

    titleEl.textContent = t('qualityLod.modalTitle');
    bodyEl.textContent = t('qualityLod.modalBody');
    listEl.innerHTML = '';

    for (const key of keys) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'logout-btn lobby quality-lod-option-btn';
        btn.textContent = formatQualityLodButtonLabel(world, key);
        btn.addEventListener('click', () => finishQualityLodModal(key));
        listEl.appendChild(btn);
    }

    return new Promise((resolve) => {
        pendingResolve = resolve;
        modal.classList.add('visible');
        modal.setAttribute('aria-hidden', 'false');
    });
}

/**
 * 入室前に品質 LOD キーを解決する（単一 LOD は自動、複数はポップアップ）
 * @param {Record<string, unknown>|null|undefined} rawWorld
 * @param {string|null|undefined} providedKey
 * @returns {Promise<string|null>}
 */
export async function resolveQualityLodKeyForEntry(rawWorld, providedKey) {
    if (!rawWorld || typeof rawWorld !== 'object') return null;
    if (providedKey != null && String(providedKey).trim()) {
        return String(providedKey).trim();
    }
    const keys = getQualityLodKeys(rawWorld);
    if (keys.length >= 2) {
        return await promptQualityLodChoice(rawWorld);
    }
    if (keys.length === 1) return keys[0];
    return null;
}
