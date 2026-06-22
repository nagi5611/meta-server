// addons/webxr-vr/client/vr-chat-panel.js — VR チャットパネル

import * as THREE from 'three';
import ThreeMeshUI from 'three-mesh-ui';
import {
    createPanelContainer,
    createPanelTitle,
    createMenuButton,
    createBodyText,
    createRow,
    getFontOpts,
    VR_UI_COLORS,
} from './vr-ui-helpers.js';
import { t } from '../../../public/js/metaverse-i18n.js';

const MAX_VISIBLE_MESSAGES = 12;

/**
 * VR チャットパネル（Quest システム KB 連携）
 */
export class VrChatPanel {
    /**
     * @param {import('./vr-menu-actions.js').VrMenuActions} actions
     * @param {HTMLElement|null} domOverlayRoot
     */
    constructor(actions, domOverlayRoot) {
        this.actions = actions;
        this.domOverlayRoot = domOverlayRoot;
        this.root = new THREE.Group();
        this.root.name = 'vr-chat-panel';
        this.root.visible = false;

        this._inputDraft = '';
        this._unsubMessages = null;
        this._kbBridge = null;
        this._inputLabel = null;
        this._messagesBlock = null;

        this._buildUi();
        this._ensureKbBridge();
    }

    _ensureKbBridge() {
        const root = this.domOverlayRoot || document.body;
        let el = document.getElementById('vr-chat-kb-bridge');
        if (!el) {
            el = document.createElement('textarea');
            el.id = 'vr-chat-kb-bridge';
            el.setAttribute('aria-hidden', 'true');
            el.className = 'vr-chat-kb-bridge';
            root.appendChild(el);
        }
        this._kbBridge = el;
        el.addEventListener('input', () => {
            this._inputDraft = el.value;
            this._syncInputLabel();
        });
    }

    _buildUi() {
        const panel = createPanelContainer({ width: 1.1, height: 0.72 });
        panel.position.set(0, 0.22, 0);

        const titleRow = createRow(0.09);
        const title = createPanelTitle(t('vrMenu.chat'));
        titleRow.add(title);
        const closeBtn = createMenuButton({
            width: 0.1,
            height: 0.08,
            label: '×',
            actionId: 'close',
        });
        titleRow.add(closeBtn);
        panel.add(titleRow);

        this._messagesBlock = new ThreeMeshUI.Block({
            width: 1,
            height: 0.42,
            padding: 0.03,
            backgroundColor: new THREE.Color(0x0d1117),
            backgroundOpacity: 0.75,
            borderRadius: 0.03,
            contentDirection: ThreeMeshUI.ContentDirection.COLUMN,
            alignItems: ThreeMeshUI.AlignItems.START,
            ...getFontOpts(),
        });
        panel.add(this._messagesBlock);

        const inputRow = createRow(0.1);
        const inputBtn = createMenuButton({
            width: 0.72,
            height: 0.09,
            label: t('vrMenu.chatTapInput'),
            actionId: 'chat-input',
        });
        this._inputLabel = inputBtn.userData.vrLabelText;
        inputRow.add(inputBtn);

        const sendBtn = createMenuButton({
            width: 0.22,
            height: 0.09,
            label: t('vrMenu.chatSend'),
            actionId: 'chat-send',
        });
        inputRow.add(sendBtn);
        panel.add(inputRow);

        this.root.add(panel);
        this.panelBlock = panel;
    }

    _syncInputLabel() {
        const preview = this._inputDraft.trim();
        const label = preview || t('vrMenu.chatTapInput');
        if (this._inputLabel?.set) {
            this._inputLabel.set({ content: label });
        }
    }

    /** メッセージ一覧を再描画 */
    refreshMessages() {
        if (!this._messagesBlock) return;
        while (this._messagesBlock.children.length > 0) {
            this._messagesBlock.remove(this._messagesBlock.children[0]);
        }

        const snapshot = this.actions.getChatMessagesSnapshot();
        const slice = snapshot.slice(-MAX_VISIBLE_MESSAGES);
        if (!slice.length) {
            this._messagesBlock.add(createBodyText(t('vrMenu.chatEmpty')));
            return;
        }

        for (const msg of slice) {
            const prefix = msg.isOwn ? `[${t('vrMenu.chatYou')}] ` : '';
            const line = `${prefix}${msg.header}: ${msg.text}`.slice(0, 120);
            this._messagesBlock.add(createBodyText(line));
        }
    }

    focusSystemKeyboard() {
        if (!this._kbBridge) return;
        this._kbBridge.value = this._inputDraft;
        this._kbBridge.focus();
    }

    sendDraft() {
        const text = (this._kbBridge?.value ?? this._inputDraft).trim();
        if (!text) return;
        this.actions.sendChatMessage(text);
        this._inputDraft = '';
        if (this._kbBridge) this._kbBridge.value = '';
        this._syncInputLabel();
    }

    show() {
        this.root.visible = true;
        this.refreshMessages();
        if (!this._unsubMessages) {
            this._unsubMessages = this.actions.onChatMessagesChanged(() => {
                if (this.root.visible) this.refreshMessages();
            });
        }
    }

    hide() {
        this.root.visible = false;
        this._kbBridge?.blur();
    }

    /**
     * @param {string} action
     * @param {string} payload
     * @returns {boolean} handled
     */
    handleAction(action, payload) {
        if (!this.root.visible) return false;
        if (action === 'close') {
            return true;
        }
        if (action === 'chat-input') {
            this.focusSystemKeyboard();
            return true;
        }
        if (action === 'chat-send') {
            this.sendDraft();
            return true;
        }
        return false;
    }

    applyLocale() {
        if (!this._inputDraft.trim() && this._inputLabel?.set) {
            this._inputLabel.set({ content: t('vrMenu.chatTapInput') });
        }
    }

    dispose() {
        if (typeof this._unsubMessages === 'function') {
            this._unsubMessages();
            this._unsubMessages = null;
        }
    }
}
