// public/js/player-action-menu.js
import { t } from './metaverse-i18n.js';
/**
 * プレイヤー名クリック時のフローティングメニュー（通報プレースホルダ・ローカルブロック）
 */
export default class PlayerActionMenu {
    /**
     * @param {{
     *   blockList: { add: (id: string) => void, has: (id: string) => boolean },
     *   chatManager: { removeChatMessagesBySenderId: (id: string) => void, clearEmojiForBlockedPlayer: (id: string) => void },
     *   networkManager: { myPlayerId: string|null },
     *   playerManager: { setRemotePlayerVisible: (id: string, vis: boolean) => void },
     * }} deps
     */
    constructor(deps) {
        this._deps = deps;
        /** @type {HTMLElement|null} */
        this._root = null;
        /** @type {string|null} */
        this._currentPlayerId = null;
        this._boundDocDismiss = this._onDocumentDismiss.bind(this);
        /** removeEventListener 用に add と同一参照 */
        this._docCaptureOpts = { capture: true };
    }

    /**
     * メニュー用 DOM を一度だけ生成する
     */
    _ensureDom() {
        if (this._root) return;
        const root = document.createElement('div');
        root.className = 'player-action-menu';
        root.setAttribute('role', 'menu');
        root.hidden = true;
        root.innerHTML = `
<button type="button" class="player-action-menu-item" data-action="report" role="menuitem">${t('playerAction.report')}</button>
<button type="button" class="player-action-menu-item" data-action="block" role="menuitem">${t('playerAction.block')}</button>`;
        document.body.appendChild(root);
        root.addEventListener('click', (e) => {
            e.stopPropagation();
            const btn = e.target.closest('[data-action]');
            if (!btn) return;
            const action = btn.getAttribute('data-action');
            if (action === 'report') {
                /* 通報機能は未実装（UI のみ） */
            } else if (action === 'block' && this._currentPlayerId) {
                const pid = this._currentPlayerId;
                this.close();
                this._runBlock(pid);
                return;
            }
            this.close();
        });
        this._root = root;
    }

    /**
     * `.player-action-menu` 以外を押したら閉じる（キャプチャでバブル阻害の影響を受けにくい）
     * @param {PointerEvent|MouseEvent|Event} e
     */
    _onDocumentDismiss(e) {
        if (!this._root || this._root.hidden) return;
        const tgt = e.target;
        if (!(tgt instanceof Node)) return;
        if (this._root.contains(tgt)) return;
        this.close();
    }

    /**
     * メニュー外検知リスナを付け直す（二重登録防止）
     */
    _attachOutsideDismissListeners() {
        this._detachOutsideDismissListeners();
        document.addEventListener('pointerdown', this._boundDocDismiss, this._docCaptureOpts);
        document.addEventListener('mousedown', this._boundDocDismiss, this._docCaptureOpts);
        document.addEventListener('click', this._boundDocDismiss, this._docCaptureOpts);
    }

    /**
     * メニュー外検知リスナを外す
     */
    _detachOutsideDismissListeners() {
        document.removeEventListener('pointerdown', this._boundDocDismiss, this._docCaptureOpts);
        document.removeEventListener('mousedown', this._boundDocDismiss, this._docCaptureOpts);
        document.removeEventListener('click', this._boundDocDismiss, this._docCaptureOpts);
    }

    /**
     * @param {string} playerId
     */
    _runBlock(playerId) {
        const { blockList, chatManager, playerManager } = this._deps;
        blockList.add(playerId);
        chatManager.removeChatMessagesBySenderId(playerId);
        chatManager.clearEmojiForBlockedPlayer(playerId);
        playerManager.setRemotePlayerVisible(playerId, false);
    }

    /**
     * アンカー近くにメニューを表示する
     * @param {HTMLElement} anchorEl
     * @param {{ playerId: string, displayName: string }} target
     */
    open(anchorEl, target) {
        this._ensureDom();
        const { networkManager } = this._deps;
        const myId = networkManager?.myPlayerId;
        if (!target?.playerId || target.playerId === myId || !anchorEl || !this._root) {
            this.close();
            return;
        }
        this.close();
        this._currentPlayerId = target.playerId;

        const reportBtn = this._root.querySelector('[data-action="report"]');
        const blockBtn = this._root.querySelector('[data-action="block"]');
        if (reportBtn) reportBtn.textContent = t('playerAction.report');
        if (blockBtn) blockBtn.textContent = t('playerAction.block');

        const rect = anchorEl.getBoundingClientRect();
        const menu = this._root;
        menu.hidden = false;
        menu.style.left = `${Math.min(rect.left, window.innerWidth - 160)}px`;
        menu.style.top = `${rect.bottom + 4}px`;

        // 開く操作のイベントが終わってから外側検知を付ける
        queueMicrotask(() => {
            if (!this._root || this._root.hidden) return;
            this._attachOutsideDismissListeners();
        });
    }

    close() {
        if (this._root) {
            this._root.hidden = true;
        }
        this._currentPlayerId = null;
        this._detachOutsideDismissListeners();
    }

    destroy() {
        this.close();
        if (this._root?.parentElement) {
            this._root.remove();
        }
        this._root = null;
    }
}
