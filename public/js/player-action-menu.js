// public/js/player-action-menu.js
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
        this._boundDocClick = this._onDocumentClick.bind(this);
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
<button type="button" class="player-action-menu-item" data-action="report" role="menuitem">通報</button>
<button type="button" class="player-action-menu-item" data-action="block" role="menuitem">ブロック</button>`;
        document.body.appendChild(root);
        root.addEventListener('click', (e) => {
            e.stopPropagation();
            const btn = e.target.closest('[data-action]');
            if (!btn) return;
            const action = btn.getAttribute('data-action');
            if (action === 'report') {
                /* 通報機能は未実装（UI のみ） */
            } else if (action === 'block' && this._currentPlayerId) {
                this._runBlock(this._currentPlayerId);
            }
            this.close();
        });
        this._root = root;
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
            return;
        }
        this.close();
        this._currentPlayerId = target.playerId;

        const rect = anchorEl.getBoundingClientRect();
        const menu = this._root;
        menu.hidden = false;
        menu.style.left = `${Math.min(rect.left, window.innerWidth - 160)}px`;
        menu.style.top = `${rect.bottom + 4}px`;

        requestAnimationFrame(() => {
            document.addEventListener('click', this._boundDocClick, false);
        });
    }

    _onDocumentClick(e) {
        if (this._root && this._root.contains(e.target)) return;
        this.close();
    }

    close() {
        if (this._root) {
            this._root.hidden = true;
        }
        this._currentPlayerId = null;
        document.removeEventListener('click', this._boundDocClick, false);
    }

    destroy() {
        this.close();
        if (this._root?.parentElement) {
            this._root.remove();
        }
        this._root = null;
    }
}
