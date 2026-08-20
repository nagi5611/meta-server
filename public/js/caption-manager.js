// public/js/caption-manager.js — リアルタイム音声字幕の表示（聞き手側）
// サーバーの 'stt-caption' を購読し、字幕 ON のときプレイヤーごとに頭上へ字幕 DOM を投影する。
// 表示位置は chat-manager.js の絵文字オーバーレイと同じ投影ロジックを踏襲。
import * as THREE from 'three';

/** final 表示を保持してから消すまでの時間(ms) */
const FINAL_DISMISS_MS = 2000;
/** interim 更新が止まったら発話終了とみなして消す(ms) */
const IDLE_CLEAR_MS = 1200;

class CaptionManager {
    /**
     * @param {object} networkManager
     * @param {object} playerManager
     * @param {object} sceneManager
     */
    constructor(networkManager, playerManager, sceneManager) {
        this.networkManager = networkManager;
        this.playerManager = playerManager;
        this.sceneManager = sceneManager;
        this.characterController = null;
        this.socket = networkManager?.socket || null;

        /** 聞き手の字幕表示 ON/OFF */
        this.enabled = false;
        /** playerId -> { text, displayText, translatedMessage, isFinal, utteranceId, dismissTimer, idleTimer } */
        this.captions = new Map();
        /** playerId -> HTMLElement */
        this.captionDivs = new Map();
        /** @type {((playerId: string) => boolean)|null} */
        this.isPlayerBlocked = null;

        this._boundOnCaption = (data) => this._onCaption(data);
        if (this.socket) this.socket.on('stt-caption', this._boundOnCaption);
    }

    /** @param {object} cc CharacterController（自分の字幕位置をカメラと同期） */
    setCharacterController(cc) {
        this.characterController = cc;
    }

    /** @param {(playerId: string) => boolean} fn */
    setPlayerBlockedCheck(fn) {
        this.isPlayerBlocked = fn;
    }

    /** ソケット差し替え時に再購読 */
    setSocket(sock) {
        if (this.socket && this._boundOnCaption) {
            try { this.socket.off('stt-caption', this._boundOnCaption); } catch (_) { /* ignore */ }
        }
        this.socket = sock;
        if (this.socket) this.socket.on('stt-caption', this._boundOnCaption);
        // 再接続後も現在の購読状態をサーバーへ再申告
        if (this.enabled) this._announce(true);
    }

    /**
     * 聞き手の字幕表示を切り替える。サーバーへ購読状態を通知（話者の capture 制御に使われる）。
     * @param {boolean} enabled
     */
    setEnabled(enabled) {
        const next = !!enabled;
        if (next === this.enabled) return;
        this.enabled = next;
        this._announce(next);
        if (!next) this._clearAll();
    }

    _announce(enabled) {
        try {
            this.socket?.emit('stt-listen', { enabled });
        } catch (_) { /* ignore */ }
    }

    /**
     * @param {string} original
     * @param {string|undefined} translatedMessage
     * @param {boolean} isOwnSpeaker
     * @returns {string}
     */
    _formatDisplayText(original, translatedMessage, isOwnSpeaker) {
        if (isOwnSpeaker) return original;
        const translated = translatedMessage;
        if (typeof translated === 'string' && translated.trim() && translated !== original) {
            return `${original} (${translated.trim()})`;
        }
        return original;
    }

    /**
     * @param {{peerId:string, username:string, text:string, isFinal:boolean, utteranceId?:number, utteranceEnd?:boolean, translatedMessage?:string}} data
     */
    _onCaption(data) {
        if (!this.enabled || !data) return;
        const playerId = data.peerId;
        if (!playerId) return;
        if (this.isPlayerBlocked && this.isPlayerBlocked(playerId)) return;

        if (data.utteranceEnd) {
            this._remove(playerId);
            return;
        }

        const text = String(data.text || '').trim();
        if (!text) {
            this._remove(playerId);
            return;
        }

        const utteranceId = Number.isFinite(data.utteranceId) ? data.utteranceId : 0;
        const isOwnSpeaker = this.networkManager?.myPlayerId === playerId;
        let entry = this.captions.get(playerId);
        const isTranslationUpdate = !!(
            entry
            && entry.utteranceId === utteranceId
            && entry.isFinal
            && data.translatedMessage
        );

        if (!entry || entry.utteranceId !== utteranceId) {
            if (entry) this._remove(playerId);
            entry = {
                text: '',
                displayText: '',
                translatedMessage: undefined,
                isFinal: false,
                utteranceId,
                username: data.username,
                dismissTimer: null,
                idleTimer: null,
            };
            this.captions.set(playerId, entry);
        }

        entry.text = text;
        entry.isFinal = !!data.isFinal;
        entry.username = data.username || entry.username;
        if (typeof data.translatedMessage === 'string' && data.translatedMessage.trim()) {
            entry.translatedMessage = data.translatedMessage.trim();
        }
        entry.displayText = this._formatDisplayText(entry.text, entry.translatedMessage, isOwnSpeaker);

        if (!isTranslationUpdate) {
            if (entry.dismissTimer) { clearTimeout(entry.dismissTimer); entry.dismissTimer = null; }
            if (entry.idleTimer) { clearTimeout(entry.idleTimer); entry.idleTimer = null; }

            if (entry.isFinal) {
                entry.dismissTimer = setTimeout(() => this._remove(playerId), FINAL_DISMISS_MS);
            } else {
                entry.idleTimer = setTimeout(() => this._remove(playerId), IDLE_CLEAR_MS);
            }
        }
        this._render(playerId);
    }

    _remove(playerId) {
        const entry = this.captions.get(playerId);
        if (entry) {
            if (entry.dismissTimer) clearTimeout(entry.dismissTimer);
            if (entry.idleTimer) clearTimeout(entry.idleTimer);
        }
        this.captions.delete(playerId);
        const div = this.captionDivs.get(playerId);
        if (div) div.style.display = 'none';
    }

    _clearAll() {
        for (const playerId of Array.from(this.captions.keys())) this._remove(playerId);
    }

    _ensureDiv(playerId) {
        let div = this.captionDivs.get(playerId);
        if (!div) {
            div = document.createElement('div');
            div.className = 'player-caption';
            div.style.position = 'absolute';
            div.style.pointerEvents = 'none';
            document.body.appendChild(div);
            this.captionDivs.set(playerId, div);
        }
        return div;
    }

    _render(playerId) {
        const entry = this.captions.get(playerId);
        if (!entry) return;
        const div = this._ensureDiv(playerId);
        div.textContent = entry.displayText || entry.text;
        div.classList.toggle('interim', !entry.isFinal);
        div.style.display = 'block';
        this._updatePosition(playerId, div);
    }

    getPlayerMesh(playerId) {
        if (!this.playerManager) return null;
        const isLocal = this.networkManager?.myPlayerId === playerId;
        if (isLocal) return this.playerManager.localPlayer;
        return this.playerManager.remotePlayers.get(playerId) ?? null;
    }

    _updatePosition(playerId, div) {
        if (!this.sceneManager) return;
        const camera = this.sceneManager.getCamera();
        const renderer = this.sceneManager.renderer;
        if (!camera || !renderer) return;

        const vector = new THREE.Vector3();
        const isLocal = this.networkManager?.myPlayerId === playerId;
        if (isLocal && this.characterController) {
            vector.copy(this.characterController.getPosition());
        } else {
            const mesh = this.getPlayerMesh(playerId);
            if (!mesh?.position) { div.style.display = 'none'; return; }
            mesh.getWorldPosition(vector);
        }

        vector.y += 2.6; // 名札(≈3.0)の少し下に字幕を出す
        vector.project(camera);

        // カメラ背面（画面外）なら隠す
        if (vector.z > 1) { div.style.display = 'none'; return; }

        const rect = renderer.domElement.getBoundingClientRect();
        const x = rect.left + (vector.x * 0.5 + 0.5) * rect.width;
        const y = rect.top + (vector.y * -0.5 + 0.5) * rect.height;
        div.style.left = x + 'px';
        div.style.top = y + 'px';
        if (div.style.display === 'none') div.style.display = 'block';
    }

    /** アニメーションループから毎フレーム呼ぶ */
    update() {
        if (!this.enabled || !this.playerManager || !this.sceneManager) return;
        this.captions.forEach((_entry, playerId) => {
            const div = this.captionDivs.get(playerId);
            if (div && div.style.display !== 'none') this._updatePosition(playerId, div);
        });
    }
}

export default CaptionManager;
