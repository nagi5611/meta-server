import * as THREE from 'three';

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

        this.init();
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
        this.addSystemMessage('チャットシステムが初期化されました');
        
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
    }

    setupNetworkEvents() {
        const socket = this.networkManager.socket;

        // Receive chat message from others
        socket.on('chat-receive', (data) => {
            this.addChatMessage(data, false);
            this.connectedPlayers.set(data.senderId, data.senderName);
        });

        // Receive own chat message echo
        socket.on('chat-my-message', (data) => {
            this.addChatMessage(data, true);
        });

        // Receive emoji broadcast
        socket.on('emoji-broadcast', (data) => {
            this.showPlayerEmoji(data.playerId, data.emoji);
        });

        // Player joined
        socket.on('player-joined', (playerState) => {
            this.connectedPlayers.set(playerState.id, playerState.username);
            this.addSystemMessage(`${playerState.username} が参加しました`);
        });

        // Player left
        socket.on('player-left', (playerId) => {
            const username = this.connectedPlayers.get(playerId);
            if (username) {
                this.addSystemMessage(`${username} が退出しました`);
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

    sendMessage(message) {
        if (!this.networkManager.socket) {
            console.warn('Socket not connected');
            return;
        }

        this.networkManager.socket.emit('chat-message', message);
    }

    addChatMessage(data, isOwnMessage = false) {
        const messageDiv = document.createElement('div');
        messageDiv.className = 'chat-message';
        
        if (isOwnMessage) {
            messageDiv.classList.add('my-message');
        }

        // Check for mentions
        const mentions = this.extractMentions(data.message);
        const isMentioned = mentions.some(m => m === `@${this.myUsername}`);
        
        if (isMentioned && !isOwnMessage) {
            messageDiv.classList.add('mention');
            this.playMentionSound();
        }

        // Create message header
        const messageHeader = document.createElement('div');
        messageHeader.className = 'message-header';
        messageHeader.textContent = data.senderName;

        // Add timestamp
        const messageTime = document.createElement('span');
        messageTime.className = 'message-time';
        const time = new Date(data.timestamp || Date.now());
        messageTime.textContent = time.toLocaleTimeString('ja-JP', { 
            hour: '2-digit', 
            minute: '2-digit' 
        });
        messageHeader.appendChild(messageTime);

        // Create message text
        const messageText = document.createElement('div');
        messageText.className = 'message-text';
        messageText.innerHTML = this.formatMessageWithMentions(data.message);

        messageDiv.appendChild(messageHeader);
        messageDiv.appendChild(messageText);

        this.chatMessages.appendChild(messageDiv);
        this.chatMessages.scrollTop = this.chatMessages.scrollHeight;

        // Animation
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

    formatMessageWithMentions(message) {
        return message.replace(/@(\w+)/g, '<span class="mention-text">@$1</span>');
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
