import * as THREE from 'three';
import { t, getMetaverseLocale } from './metaverse-i18n.js';

/**
 * チャット時刻表示用 BCP 47 タグ（UI 言語に合わせる）
 * @returns {string}
 */
function timeLocaleForMetaverse() {
    switch (getMetaverseLocale()) {
        case 'en':
            return 'en-US';
        case 'zh':
            return 'zh-CN';
        default:
            return 'ja-JP';
    }
}

/**
 * ChatManager - チャット機能を管理するクラス
 */
class ChatManager {
    constructor(networkManager, playerManager, sceneManager, options = {}) {
        this.networkManager = networkManager;
        this.playerManager = playerManager;
        this.sceneManager = sceneManager;
        
        // UI Elements
        this.chatContainer = document.getElementById('chat-container');
        this.chatMessages = document.getElementById('chat-messages');
        this.chatInput = document.getElementById('chat-input');
        this.chatSendBtn = document.getElementById('chat-send-btn');
        this.chatMinimizeBtn = document.getElementById('chat-minimize-btn');
        this.emojiMenu = document.getElementById('emoji-menu');
        this.stampBtn = document.getElementById('stamp-btn');
        
        // State (モバイル時は初期で最小化)
        this.isMinimized = options.initialMinimized ?? false;
        this.myUsername = localStorage.getItem('username') || 'Guest';
        this.connectedPlayers = new Map(); // playerId -> username
        
        /** @type {{ div: HTMLElement, text: string } | null} 送信中の自分用楽観バブル（サーバーは ack より先に chat-my-message を送る） */
        this.optimisticPendingEntry = null;
        /** chat-message 応答待ち（多重送信で in_flight を避ける） */
        this.chatAwaitingAck = false;
        
        // Emoji list
        this.emojiList = [
            '😀','😂','😍','😎','😭','😡','👍','👏',
            '🙌','🙏','🎉','💯','🔥','😳','🤔','😴',
            '🥺','😱','🤩','😇','😅'
        ];
        
        // Emoji display management
        this.playerEmojis = new Map(); // playerId -> {emoji, timeoutId}
        this.emojiDivs = new Map(); // playerId -> HTML element
        /** CharacterController（自分用エモート位置をカメラと同期） */
        this.characterController = null;

        /** @type {((playerId: string) => boolean)|null} */
        this._playerBlockedCheck = null;

        this.init();
    }

    /**
     * ローカルブロック一覧に照らし相手を表示から除外するか
     * @param {string|null|undefined} playerId
     * @returns {boolean}
     */
    _isPlayerBlocked(playerId) {
        if (playerId == null || playerId === '') return false;
        return typeof this._playerBlockedCheck === 'function' && this._playerBlockedCheck(String(playerId));
    }

    /**
     * @param {(playerId: string) => boolean|null|undefined} fn
     */
    setPlayerBlockedCheck(fn) {
        this._playerBlockedCheck = typeof fn === 'function' ? fn : null;
    }

    /**
     * 指定プレイヤーからのチャット DOM を除去する（ローカルブロック時）
     * @param {string} playerId
     */
    removeChatMessagesBySenderId(playerId) {
        if (!this.chatMessages || playerId == null || playerId === '') return;
        const sel = `div.chat-message[data-sender-id="${CSS.escape(String(playerId))}"]`;
        this.chatMessages.querySelectorAll(sel).forEach((el) => el.remove());
    }

    /**
     * ブロック済みプレイヤー頭上の絵文字を消す
     * @param {string} playerId
     */
    clearEmojiForBlockedPlayer(playerId) {
        if (!playerId) return;
        const data = this.playerEmojis.get(playerId);
        if (data?.timeoutId) {
            clearTimeout(data.timeoutId);
        }
        this.playerEmojis.delete(playerId);
        const div = this.emojiDivs.get(playerId);
        if (div?.parentElement) {
            div.remove();
        }
        this.emojiDivs.delete(playerId);
        this.updatePlayerEmojis();
    }

    init() {
        console.log('Initializing Chat Manager...');

        if (this.chatContainer) {
            this.chatContainer.classList.toggle('minimized', this.isMinimized);
            if (this.chatMinimizeBtn) {
                this.chatMinimizeBtn.textContent = this.isMinimized ? '+' : '−';
            }
        }
        
        // Setup UI events
        this.setupUIEvents();
        
        // Setup network events
        this.setupNetworkEvents();
        
        // Render emoji menu
        this.renderEmojiMenu();
        
        // Add welcome message
        this.addSystemMessage(t('chat.systemInit'));
        
        console.log('Chat Manager initialized!');
    }

    setupUIEvents() {
        // Send message
        const sendMessage = () => {
            const message = this.chatInput.value.trim();
            if (message) {
                this.sendMessage(message);
                this.chatInput.value = '';
            }
        };

        this.chatSendBtn.addEventListener('click', sendMessage);
        
        this.chatInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                sendMessage();
            }
        });

        // Minimize/Maximize chat
        this.chatMinimizeBtn.addEventListener('click', () => {
            this.toggleMinimize();
        });

        this.chatContainer.addEventListener('click', (e) => {
            if (this.isMinimized && e.target === this.chatContainer) {
                this.toggleMinimize();
            }
        });

        // Stamp button
        if (this.stampBtn) {
            this.stampBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.toggleEmojiMenu();
            });
        }

        // Close emoji menu when clicking outside
        document.addEventListener('click', (e) => {
            if (this.emojiMenu.classList.contains('show') && 
                !this.emojiMenu.contains(e.target) && 
                !this.stampBtn.contains(e.target)) {
                this.hideEmojiMenu();
            }
        });

        if (this.chatMessages) {
            this.chatMessages.addEventListener('click', (e) => {
                const header = e.target.closest('.message-header-actionable');
                if (!header || !this.networkManager) return;
                e.stopPropagation();
                const root = header.closest('.chat-message');
                const senderId = root?.getAttribute('data-sender-id');
                if (!senderId || senderId === this.networkManager.myPlayerId) return;
                const displayName =
                    header.dataset.playerDisplayName ||
                    (header.firstChild && header.firstChild.nodeType === Node.TEXT_NODE
                        ? String(header.firstChild.textContent || '').trim()
                        : 'Player');
                window.dispatchEvent(
                    new CustomEvent('metaverse-player-name-menu', {
                        detail: { anchorEl: header, playerId: senderId, displayName },
                    })
                );
            });
        }
    }

    setupNetworkEvents() {
        const socket = this.networkManager.socket;

        // Receive chat message from others
        socket.on('chat-receive', (data) => {
            if (data?.senderId != null && this._isPlayerBlocked(data.senderId)) {
                return;
            }
            this.addChatMessage(data, false);
            this.connectedPlayers.set(data.senderId, data.senderName);
        });

        // Receive own chat message echo（サーバー送信順: 先に本イベント、後に emit の ack）
        socket.on('chat-my-message', (data) => {
            if (this.tryFinalizeOptimisticOwnEcho(data)) {
                return;
            }
            this.addChatMessage(data, true);
        });

        // Receive emoji broadcast
        socket.on('emoji-broadcast', (data) => {
            this.showPlayerEmoji(data.playerId, data.emoji);
        });

        // Player joined
        socket.on('player-joined', (playerState) => {
            this.connectedPlayers.set(playerState.id, playerState.username);
            if (!this._isPlayerBlocked(playerState.id)) {
                this.addSystemMessage(t('chat.joined', { name: playerState.username }));
            }
        });

        // Player left
        socket.on('player-left', (playerId) => {
            const username = this.connectedPlayers.get(playerId);
            if (username) {
                this.addSystemMessage(t('chat.left', { name: username }));
                this.connectedPlayers.delete(playerId);
            }
        });

        // Current players list
        socket.on('current-players', (players) => {
            players.forEach(player => {
                if (player.username) {
                    this.connectedPlayers.set(player.id, player.username);
                }
            });
        });
    }

    /**
     * chat-my-message が楽観送信と同じ本文なら重複表示せず確定表示に切り替える
     * @param {{ message?: string, timestamp?: number }} data
     * @returns {boolean} 処理済みなら true
     */
    tryFinalizeOptimisticOwnEcho(data) {
        const pending = this.optimisticPendingEntry;
        if (!pending || !pending.div || !pending.div.isConnected) return false;
        const got = typeof data?.message === 'string' ? data.message : '';
        if (got !== pending.text) return false;
        if (!pending.div.classList.contains('chat-message-pending')) return false;
        this.finalizeOptimisticBubble(pending.div, data.timestamp);
        this.optimisticPendingEntry = null;
        return true;
    }

    /**
     * 楽観バブルをサーバー確定済み表示にする
     * @param {HTMLElement} messageDiv
     * @param {number} [serverTimestamp]
     */
    finalizeOptimisticBubble(messageDiv, serverTimestamp) {
        messageDiv.classList.remove('chat-message-pending');
        const badge = messageDiv.querySelector('.chat-pending-status');
        if (badge) badge.remove();
        const span = messageDiv.querySelector('.message-time');
        if (span != null) {
            const t0 = typeof serverTimestamp === 'number' ? serverTimestamp : Date.now();
            span.textContent = new Date(t0).toLocaleTimeString(timeLocaleForMetaverse(), {
                hour: '2-digit',
                minute: '2-digit',
            });
        }
    }

    /**
     * 送信前の仮表示バブルを描画する
     * @param {string} plainText 生メッセージ
     * @returns {HTMLElement} ルート .chat-message
     */
    addOptimisticOutgoingBubble(plainText) {
        const messageDiv = document.createElement('div');
        messageDiv.className = 'chat-message my-message chat-message-pending';

        const messageHeader = document.createElement('div');
        messageHeader.className = 'message-header';
        messageHeader.textContent = this.myUsername;

        const messageTime = document.createElement('span');
        messageTime.className = 'message-time';
        messageTime.textContent = new Date().toLocaleTimeString(timeLocaleForMetaverse(), {
            hour: '2-digit',
            minute: '2-digit',
        });
        messageHeader.appendChild(messageTime);
        messageDiv.appendChild(messageHeader);

        const messageText = document.createElement('div');
        messageText.className = 'message-text';
        messageText.innerHTML = this.formatChatMessageHtml(plainText);
        messageDiv.appendChild(messageText);

        const statusRow = document.createElement('div');
        statusRow.className = 'chat-pending-status';
        statusRow.textContent = t('chat.sending');
        messageDiv.appendChild(statusRow);

        const myId = this.networkManager?.myPlayerId;
        if (myId) {
            messageDiv.setAttribute('data-sender-id', myId);
        }

        this.chatMessages.appendChild(messageDiv);
        this.chatMessages.scrollTop = this.chatMessages.scrollHeight;
        messageDiv.style.opacity = '1';
        return messageDiv;
    }

    /**
     * 楽観バブルを送信失敗表示にする（取り消し線＋理由）
     * @param {HTMLElement|null} div
     * @param {{ message?: string, code?: string }} res
     */
    markOptimisticBubbleFailed(div, res) {
        if (!div || !div.isConnected) return;
        div.classList.remove('chat-message-pending');
        div.classList.add('chat-message-failed');
        const body = div.querySelector('.message-text');
        if (body) body.classList.add('message-text-strikethrough');
        let badge = div.querySelector('.chat-pending-status');
        if (!badge) {
            badge = document.createElement('div');
            badge.className = 'chat-pending-status';
            div.appendChild(badge);
        }
        const txt =
            typeof res?.message === 'string' && res.message.trim()
                ? res.message.trim()
                : t('chat.sendFailedBubble');
        badge.textContent = txt;
        this.chatMessages.scrollTop = this.chatMessages.scrollHeight;
    }

    sendMessage(message) {
        if (!this.networkManager.socket) {
            console.warn('Socket not connected');
            return;
        }

        if (this.chatAwaitingAck) {
            this.addSystemMessage(t('chat.waitSend'));
            return;
        }

        this.chatAwaitingAck = true;
        const optimisticDiv = this.addOptimisticOutgoingBubble(message);
        this.optimisticPendingEntry = { div: optimisticDiv, text: message };

        this.networkManager.socket.emit('chat-message', message, (res) => {
            this.chatAwaitingAck = false;

            if (!res || res.ok) {
                if (optimisticDiv.classList.contains('chat-message-pending')) {
                    this.finalizeOptimisticBubble(optimisticDiv, Date.now());
                }
                if (this.optimisticPendingEntry?.div === optimisticDiv) {
                    this.optimisticPendingEntry = null;
                }
                return;
            }

            if (this.optimisticPendingEntry?.div === optimisticDiv) {
                this.optimisticPendingEntry = null;
            }

            if (res.code === 'ng_word') {
                this.markOptimisticBubbleFailed(optimisticDiv, res);
                if (res.message) {
                    this.addSystemMessage(res.message);
                }
                return;
            }
            if (res.code === 'inappropriate') {
                this.markOptimisticBubbleFailed(optimisticDiv, res);
                return;
            }
            if (res.code === 'room_rate') {
                this.markOptimisticBubbleFailed(optimisticDiv, { message: t('chat.sendFailed') });
                this.addSystemMessage(t('chat.sendFailed'));
                return;
            }
            if (res.message) {
                this.markOptimisticBubbleFailed(optimisticDiv, res);
                this.addSystemMessage(res.message);
                return;
            }
            this.markOptimisticBubbleFailed(optimisticDiv, { message: t('chat.sendFailed') });
            this.addSystemMessage(t('chat.sendFailed'));
        });
    }

    /**
     * チャット1件を描画する。他者向け moderationWarning では本文を隠し目アイコンで切替
     * @param {{ senderName: string, senderId: string, message: string, timestamp?: number, moderationWarning?: boolean }} data
     * @param {boolean} isOwnMessage
     */
    addChatMessage(data, isOwnMessage = false) {
        if (!isOwnMessage && data?.senderId != null && this._isPlayerBlocked(data.senderId)) {
            return;
        }

        const messageDiv = document.createElement('div');
        messageDiv.className = 'chat-message';

        if (isOwnMessage) {
            messageDiv.classList.add('my-message');
        }

        const senderIdAttr = isOwnMessage
            ? (this.networkManager?.myPlayerId || '')
            : (data.senderId || '');
        if (senderIdAttr) {
            messageDiv.setAttribute('data-sender-id', senderIdAttr);
        }

        const showModerationUi = data.moderationWarning === true && !isOwnMessage;

        // Check for mentions（本文は data.message を参照）
        const mentions = this.extractMentions(data.message);
        const isMentioned = mentions.some((m) => m === `@${this.myUsername}`);

        if (isMentioned && !isOwnMessage) {
            messageDiv.classList.add('mention');
            this.playMentionSound();
        }

        const messageHeader = document.createElement('div');
        messageHeader.className = 'message-header';
        messageHeader.textContent = data.senderName;

        if (!isOwnMessage && data.senderId) {
            messageHeader.classList.add('message-header-actionable');
            messageHeader.setAttribute('role', 'button');
            messageHeader.tabIndex = 0;
            messageHeader.title = t('ui.playerMenuTitle');
            messageHeader.dataset.playerDisplayName = data.senderName || 'Player';
        }

        const messageTime = document.createElement('span');
        messageTime.className = 'message-time';
        const time = new Date(data.timestamp || Date.now());
        messageTime.textContent = time.toLocaleTimeString(timeLocaleForMetaverse(), {
            hour: '2-digit',
            minute: '2-digit',
        });
        messageHeader.appendChild(messageTime);

        messageDiv.appendChild(messageHeader);

        if (showModerationUi) {
            const warnRow = document.createElement('div');
            warnRow.className = 'chat-moderation-warn-row';
            const warnLabel = document.createElement('span');
            warnLabel.className = 'chat-moderation-warn-label';
            warnLabel.textContent = t('chat.moderationWarn');
            const eyeBtn = document.createElement('button');
            eyeBtn.type = 'button';
            eyeBtn.className = 'chat-moderation-reveal-btn';
            eyeBtn.setAttribute('aria-label', t('chat.showContentAria'));
            eyeBtn.title = t('chat.showContentTitle');
            eyeBtn.innerHTML = '<i class="bi bi-eye" aria-hidden="true"></i>';

            const bodyWrap = document.createElement('div');
            bodyWrap.className = 'chat-moderation-body';
            bodyWrap.hidden = true;

            const messageText = document.createElement('div');
            messageText.className = 'message-text';
            messageText.innerHTML = this.formatChatMessageHtml(data.message);

            bodyWrap.appendChild(messageText);
            warnRow.appendChild(warnLabel);
            warnRow.appendChild(eyeBtn);
            messageDiv.appendChild(warnRow);
            messageDiv.appendChild(bodyWrap);

            eyeBtn.addEventListener('click', () => {
                bodyWrap.hidden = !bodyWrap.hidden;
                const icon = eyeBtn.querySelector('i');
                if (bodyWrap.hidden) {
                    if (icon) {
                        icon.className = 'bi bi-eye';
                    }
                    eyeBtn.title = t('chat.showContentTitle');
                } else {
                    if (icon) {
                        icon.className = 'bi bi-eye-slash';
                    }
                    eyeBtn.title = t('chat.hideContentTitle');
                }
            });
        } else {
            const messageText = document.createElement('div');
            messageText.className = 'message-text';
            messageText.innerHTML = this.formatChatMessageHtml(data.message);
            messageDiv.appendChild(messageText);
        }

        this.chatMessages.appendChild(messageDiv);
        this.chatMessages.scrollTop = this.chatMessages.scrollHeight;

        messageDiv.style.opacity = '0';
        requestAnimationFrame(() => {
            messageDiv.style.transition = 'opacity 0.3s ease';
            messageDiv.style.opacity = '1';
        });
    }

    addSystemMessage(message) {
        const messageDiv = document.createElement('div');
        messageDiv.className = 'chat-message system-message';

        const messageText = document.createElement('div');
        messageText.className = 'message-text';
        messageText.textContent = message;

        messageDiv.appendChild(messageText);
        this.chatMessages.appendChild(messageDiv);
        this.chatMessages.scrollTop = this.chatMessages.scrollHeight;
    }

    extractMentions(message) {
        const mentionRegex = /@(\w+)/g;
        const mentions = [];
        let match;
        while ((match = mentionRegex.exec(message)) !== null) {
            mentions.push('@' + match[1]);
        }
        return mentions;
    }

    /**
     * HTML に挿入する前に特殊文字をエスケープする（XSS 対策）
     * @param {string} str
     * @returns {string}
     */
    escapeHtml(str) {
        return String(str ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    /**
     * エスケープ後に @word のみ mention 用 span でラップした HTML を返す
     * @param {string} message
     * @returns {string}
     */
    formatChatMessageHtml(message) {
        const escaped = this.escapeHtml(message);
        return escaped.replace(/@(\w+)/g, '<span class="mention-text">@$1</span>');
    }

    playMentionSound() {
        // Optional: Play mention sound if audio file exists
        // const audio = new Audio('assets/mention.mp3');
        // audio.volume = 0.3;
        // audio.play().catch(() => {});
    }

    toggleMinimize() {
        this.isMinimized = !this.isMinimized;
        this.chatContainer.classList.toggle('minimized', this.isMinimized);
        this.chatMinimizeBtn.textContent = this.isMinimized ? '+' : '−';
    }

    // Emoji/Stamp functionality
    renderEmojiMenu() {
        this.emojiMenu.innerHTML = '';
        
        this.emojiList.forEach(emoji => {
            const btn = document.createElement('button');
            btn.className = 'emoji-btn';
            btn.textContent = emoji;
            btn.title = emoji;
            
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.sendEmoji(emoji);
                this.hideEmojiMenu();
            });
            
            this.emojiMenu.appendChild(btn);
        });
    }

    toggleEmojiMenu() {
        if (this.emojiMenu.classList.contains('show')) {
            this.hideEmojiMenu();
        } else {
            this.showEmojiMenu();
        }
    }

    showEmojiMenu() {
        this.emojiMenu.classList.add('show');
    }

    hideEmojiMenu() {
        this.emojiMenu.classList.remove('show');
    }

    /**
     * CharacterController を設定（自分のエモート位置をカメラと同期）
     * @param {import('./character-controller.js').default} cc
     */
    setCharacterController(cc) {
        this.characterController = cc;
    }

    sendEmoji(emoji) {
        if (!this.networkManager.socket) {
            console.warn('Socket not connected');
            return;
        }

        this.networkManager.socket.emit('send-emoji', { emoji });
    }

    showPlayerEmoji(playerId, emoji) {
        if (!playerId || !emoji) return;
        if (this._isPlayerBlocked(playerId)) return;

        // Safety check - wait until managers are ready
        if (!this.playerManager || !this.sceneManager) {
            console.warn('Chat manager not fully initialized yet');
            return;
        }

        // Clear existing timeout
        if (this.playerEmojis.has(playerId)) {
            clearTimeout(this.playerEmojis.get(playerId).timeoutId);
        }

        // Set new emoji
        const timeoutId = setTimeout(() => {
            this.playerEmojis.delete(playerId);
            this.updatePlayerEmojis();
        }, 3000);

        this.playerEmojis.set(playerId, {
            emoji: emoji,
            timeoutId: timeoutId
        });

        this.updatePlayerEmojis();
    }

    updatePlayerEmojis() {
        // Hide all emoji divs first
        this.emojiDivs.forEach(div => {
            if (div.parentElement) {
                div.style.display = 'none';
            }
        });

        // Show active emojis
        this.playerEmojis.forEach((data, playerId) => {
            let div = this.emojiDivs.get(playerId);

            if (!div) {
                div = document.createElement('div');
                div.className = 'player-emoji';
                div.style.position = 'absolute';
                div.style.fontSize = '36px';
                div.style.zIndex = '1500';
                div.style.pointerEvents = 'none';
                document.body.appendChild(div);
                this.emojiDivs.set(playerId, div);
            }

            div.textContent = data.emoji;
            div.style.display = 'block';

            this.updateEmojiPosition(playerId, div);
        });
    }

    /**
     * プレイヤーの3D位置を取得（自分: localPlayer / 他: remotePlayers）
     * @param {string} playerId
     * @returns {THREE.Object3D|null}
     */
    getPlayerMesh(playerId) {
        if (!this.playerManager) return null;
        const isLocal = this.networkManager?.myPlayerId === playerId;
        if (isLocal) {
            return this.playerManager.localPlayer;
        }
        return this.playerManager.remotePlayers.get(playerId) ?? null;
    }

    updateEmojiPosition(playerId, emojiDiv) {
        if (!this.sceneManager) return;

        const camera = this.sceneManager.getCamera();
        const renderer = this.sceneManager.renderer;
        if (!camera || !renderer) return;

        const vector = new THREE.Vector3();
        const isLocal = this.networkManager?.myPlayerId === playerId;

        if (isLocal && this.characterController) {
            // 自分: カメラと同じ位置源（CharacterController）を使用してずれを防ぐ
            vector.copy(this.characterController.getPosition());
        } else {
            const playerMesh = this.getPlayerMesh(playerId);
            if (!playerMesh?.position) return;
            playerMesh.getWorldPosition(vector);
        }

        vector.y += 3.5; // アバターの上 3.5 の高さに表示
        vector.project(camera);

        const rect = renderer.domElement.getBoundingClientRect();
        const xNorm = vector.x * 0.5 + 0.5;
        const yNorm = vector.y * -0.5 + 0.5;
        const x = rect.left + xNorm * rect.width;
        const y = rect.top + yNorm * rect.height;

        emojiDiv.style.left = x + 'px';
        emojiDiv.style.top = y + 'px';
    }

    // Called from animation loop
    update() {
        // Safety check
        if (!this.playerManager || !this.sceneManager) {
            return;
        }
        
        // Update emoji positions each frame
        this.playerEmojis.forEach((data, playerId) => {
            const div = this.emojiDivs.get(playerId);
            if (div && div.style.display !== 'none') {
                this.updateEmojiPosition(playerId, div);
            }
        });
    }

    destroy() {
        // Cleanup
        this.playerEmojis.forEach(data => {
            if (data.timeoutId) {
                clearTimeout(data.timeoutId);
            }
        });

        this.emojiDivs.forEach(div => {
            if (div.parentElement) {
                div.remove();
            }
        });

        this.playerEmojis.clear();
        this.emojiDivs.clear();
    }
}

export default ChatManager;
