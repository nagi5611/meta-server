/**
 * mobile-ui-manager.js - モバイル用UI制御（ハンバーガーメニュー、コンパクトinfo）
 */

import { isMobile } from './mobile-utils.js';

class MobileUIManager {
    constructor() {
        this.menuToggle = null;
        this.menuBar = null;
    }

    /**
     * モバイル用UIを初期化
     */
    init() {
        if (!isMobile()) return;

        this.menuToggle = document.getElementById('mobile-menu-toggle');
        this.menuBar = document.getElementById('menu-bar');

        if (!this.menuToggle || !this.menuBar) return;

        this.menuToggle.addEventListener('click', () => this.toggleMenu());
    }

    toggleMenu() {
        if (!this.menuBar) return;
        this.menuBar.classList.toggle('mobile-menu-open');
    }

    closeMenu() {
        if (this.menuBar) {
            this.menuBar.classList.remove('mobile-menu-open');
        }
    }

    /**
     * モバイル用 info を更新
     * @param {string} worldName
     * @param {{ x: number, y: number, z: number }} position
     * @param {number} playerCount
     */
    updateMobileInfo(worldName, position, playerCount) {
        if (!isMobile()) return;

        const worldEl = document.getElementById('mobile-world-name');
        const posEl = document.getElementById('mobile-position');
        const countEl = document.getElementById('mobile-player-count');

        if (worldEl) worldEl.textContent = worldName || '-';
        if (posEl && position) {
            posEl.textContent = `${Math.round(position.x)}, ${Math.round(position.y)}, ${Math.round(position.z)}`;
        }
        if (countEl) countEl.textContent = String(playerCount ?? 0);
    }

    destroy() {
        this.closeMenu();
        this.menuToggle = null;
        this.menuBar = null;
    }
}

export default new MobileUIManager();
