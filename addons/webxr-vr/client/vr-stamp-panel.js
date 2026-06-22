// addons/webxr-vr/client/vr-stamp-panel.js — VR スタンプ（絵文字）パネル

import * as THREE from 'three';
import ThreeMeshUI from 'three-mesh-ui';
import {
    createPanelContainer,
    createPanelTitle,
    createMenuButton,
    createRow,
    getFontOpts,
} from './vr-ui-helpers.js';
import { t } from '../../../public/js/metaverse-i18n.js';

/**
 * VR スタンプパネル（チャットとは独立）
 */
export class VrStampPanel {
    /**
     * @param {import('./vr-menu-actions.js').VrMenuActions} actions
     */
    constructor(actions) {
        this.actions = actions;
        this.root = new THREE.Group();
        this.root.name = 'vr-stamp-panel';
        this.root.visible = false;
        this._gridBlock = null;
        this._buildUi();
    }

    _buildUi() {
        const panel = createPanelContainer({ width: 0.95, height: 0.55 });
        panel.position.set(0, 0.18, 0);

        const titleRow = createRow(0.09);
        titleRow.add(createPanelTitle(t('vrMenu.stamp')));
        titleRow.add(createMenuButton({
            width: 0.1,
            height: 0.08,
            label: '×',
            actionId: 'close',
        }));
        panel.add(titleRow);

        this._gridBlock = new ThreeMeshUI.Block({
            width: 1,
            height: 0.38,
            padding: 0.02,
            contentDirection: ThreeMeshUI.ContentDirection.ROW,
            flexWrap: 'wrap',
            justifyContent: ThreeMeshUI.JustifyContent.START,
            backgroundOpacity: 0,
            ...getFontOpts(),
        });
        panel.add(this._gridBlock);
        this.root.add(panel);
    }

    _rebuildGrid() {
        if (!this._gridBlock) return;
        while (this._gridBlock.children.length > 0) {
            this._gridBlock.remove(this._gridBlock.children[0]);
        }
        for (const emoji of this.actions.getEmojiList()) {
            const btn = createMenuButton({
                width: 0.11,
                height: 0.11,
                label: emoji,
                actionId: 'stamp-emoji',
                actionPayload: emoji,
            });
            this._gridBlock.add(btn);
        }
    }

    show() {
        this._rebuildGrid();
        this.root.visible = true;
    }

    hide() {
        this.root.visible = false;
    }

    /**
     * @param {string} action
     * @param {string} payload
     * @returns {boolean}
     */
    handleAction(action, payload) {
        if (!this.root.visible) return false;
        if (action === 'close') return true;
        if (action === 'stamp-emoji' && payload) {
            this.actions.sendEmoji(payload);
            return true;
        }
        return false;
    }

    dispose() {
        /* noop */
    }
}
