// public/js/rod-selection.js — 入室時の品質ロッド選択（クライアントローカルのみ）

import {
    DEFAULT_ROD_ID,
    worldHasMultipleRods,
    ensureWorldRodsShape,
} from './world-rod-resolve.js';

/**
 * ロッド2以上あるワールドで選択 UI を表示し rodId を返す
 * @param {Record<string, unknown>|null|undefined} world
 * @returns {Promise<string>}
 */
export async function promptRodSelection(world) {
    if (!world || typeof world !== 'object') return DEFAULT_ROD_ID;
    ensureWorldRodsShape(world);
    if (!worldHasMultipleRods(world)) return DEFAULT_ROD_ID;

    const modal = document.getElementById('rod-selection-modal');
    const listEl = document.getElementById('rod-selection-list');
    const titleEl = document.getElementById('rod-selection-world-name');
    if (!modal || !listEl) return DEFAULT_ROD_ID;

    const worldName =
        world.name != null && String(world.name).trim() ? String(world.name).trim() : String(world.id || '');

    if (titleEl) titleEl.textContent = worldName;

    listEl.innerHTML = '';
    const rods = /** @type {{ id: string, label: string, description: string }[]} */ (world.rods);

    return new Promise((resolve) => {
        for (const rod of rods) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'rod-selection-item';
            btn.dataset.rodId = rod.id;

            const nameSpan = document.createElement('span');
            nameSpan.className = 'rod-selection-item-name';
            nameSpan.textContent = rod.label || rod.id;

            btn.appendChild(nameSpan);

            const desc = String(rod.description || '').trim();
            if (desc) {
                const descSpan = document.createElement('span');
                descSpan.className = 'rod-selection-item-desc';
                descSpan.textContent = desc;
                btn.appendChild(descSpan);
            }

            btn.addEventListener('click', () => {
                modal.classList.remove('visible');
                modal.setAttribute('aria-hidden', 'true');
                resolve(rod.id);
            });
            listEl.appendChild(btn);
        }

        modal.classList.add('visible');
        modal.setAttribute('aria-hidden', 'false');
    });
}
