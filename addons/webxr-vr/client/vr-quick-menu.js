// addons/webxr-vr/client/vr-quick-menu.js — VR クイックメニュー本体

import * as THREE from 'three';
import ThreeMeshUI from 'three-mesh-ui';
import { pollLeftYButtonEdge } from './vr-quick-menu-input.js';
import { VrUiRaycast } from './vr-ui-raycast.js';
import { VrMenuActions } from './vr-menu-actions.js';
import { VrChatPanel } from './vr-chat-panel.js';
import { VrStampPanel } from './vr-stamp-panel.js';
import { VrSettingsPanel } from './vr-settings-panel.js';
import {
    createMenuButton,
    createPanelContainer,
    createPanelTitle,
    createBodyText,
    createRow,
    getFontOpts,
    VR_UI_COLORS,
} from './vr-ui-helpers.js';
import { t } from '../../../public/js/metaverse-i18n.js';

/** @typedef {'chat'|'stamp'|'settings'|'help'|'admin'|'restart'|'logout'|null} ActivePanelId */

const MENU_DISTANCE = 1.0;
const MENU_PITCH_DEG = 20;

/**
 * VR クイックメニュー（three-mesh-ui）
 */
export class VrQuickMenu {
    /**
     * @param {object} opts
     * @param {object} opts.app
     * @param {THREE.WebGLRenderer} opts.renderer
     * @param {THREE.Camera} opts.camera
     * @param {THREE.Scene} opts.scene
     * @param {HTMLElement|null} [opts.domOverlayRoot]
     */
    constructor({ app, renderer, camera, scene, domOverlayRoot = null }) {
        this.app = app;
        this.renderer = renderer;
        this.camera = camera;
        this.scene = scene;
        this.domOverlayRoot = domOverlayRoot;

        this.actions = new VrMenuActions(app);
        this.raycast = new VrUiRaycast(renderer);
        this.raycast.wireControllers();
        this.raycast.onSelect = (action, payload) => {
            void this._handleSelect(action, payload);
        };

        this.chatPanel = new VrChatPanel(this.actions, domOverlayRoot);
        this.stampPanel = new VrStampPanel(this.actions);
        this.settingsPanel = new VrSettingsPanel(this.actions);

        this._attached = false;
        this._mainVisible = false;
        /** @type {ActivePanelId} */
        this._activePanel = null;
        this._prevYPressed = false;
        this._yawOnly = new THREE.Euler(0, 0, 0, 'YXZ');
        this._menuItems = /** @type {Map<string, import('three-mesh-ui').Block>} */ (new Map());

        this.root = new THREE.Group();
        this.root.name = 'vr-quick-menu-root';
        this.root.visible = false;

        this.cameraAnchor = new THREE.Group();
        this.cameraAnchor.name = 'vr-quick-menu-anchor';
        this.cameraAnchor.position.set(0, -0.25, -MENU_DISTANCE);
        this.cameraAnchor.rotation.x = -THREE.MathUtils.degToRad(MENU_PITCH_DEG);

        this.menuBar = this._buildMenuBar();
        this.subPanelHost = new THREE.Group();
        this.subPanelHost.position.set(0, 0.28, 0);

        this.cameraAnchor.add(this.menuBar);
        this.cameraAnchor.add(this.subPanelHost);
        this.subPanelHost.add(this.chatPanel.root);
        this.subPanelHost.add(this.stampPanel.root);
        this.subPanelHost.add(this.settingsPanel.root);
        this.root.add(this.cameraAnchor);

        this._confirmPanel = null;
        this._helpPanel = null;
        this._adminPanel = null;

        this._onLocaleChanged = () => this._applyLocale();
        window.addEventListener('metaverse-locale-changed', this._onLocaleChanged);
    }

    /**
     * メインメニューバー構築
     * @returns {import('three-mesh-ui').Block}
     */
    _buildMenuBar() {
        const bar = new ThreeMeshUI.Block({
            width: 1.35,
            height: 0.14,
            padding: 0.02,
            backgroundColor: new THREE.Color(VR_UI_COLORS.bg),
            backgroundOpacity: 0.9,
            borderRadius: 0.04,
            contentDirection: ThreeMeshUI.ContentDirection.ROW,
            justifyContent: ThreeMeshUI.JustifyContent.CENTER,
            alignItems: ThreeMeshUI.AlignItems.CENTER,
            ...getFontOpts(),
        });

        const items = [
            { id: 'admin', labelKey: 'vrMenu.admin', icon: '🛡', adminOnly: true },
            { id: 'mic', labelKey: 'vrMenu.mic', icon: '🎤' },
            { id: 'speaker', labelKey: 'vrMenu.speaker', icon: '🔊' },
            { id: 'chat', labelKey: 'vrMenu.chat', icon: '💬' },
            { id: 'stamp', labelKey: 'vrMenu.stamp', icon: '😀' },
            { id: 'help', labelKey: 'vrMenu.help', icon: '❓' },
            { id: 'restart', labelKey: 'vrMenu.restart', icon: '🔄' },
            { id: 'settings', labelKey: 'vrMenu.settings', icon: '⚙' },
            { id: 'logout', labelKey: 'vrMenu.logout', icon: '🚪' },
        ];

        for (const item of items) {
            const btn = createMenuButton({
                width: 0.11,
                height: 0.1,
                label: `${item.icon}\n${t(item.labelKey)}`,
                actionId: item.id,
            });
            btn.userData.vrAdminOnly = !!item.adminOnly;
            if (item.adminOnly) btn.visible = false;
            bar.add(btn);
            this._menuItems.set(item.id, btn);
        }

        return bar;
    }

    /** @returns {boolean} */
    isMainVisible() {
        return this._mainVisible && this._attached;
    }

    attach() {
        if (this._attached) return;
        this.camera.add(this.root);
        this.root.visible = false;
        this._attached = true;
        this.actions.warnIfVideoStreamingInVr();
        this.app.menuManager?.setVrImmersiveActive?.(true);
        this._set2dUiHidden(true);
    }

    detach() {
        if (!this._attached) return;
        this._hideAll();
        this.camera.remove(this.root);
        this._attached = false;
        this.app.menuManager?.setVrImmersiveActive?.(false);
        this._set2dUiHidden(false);
    }

    /**
     * @param {boolean} hidden
     */
    _set2dUiHidden(hidden) {
        const root = this.domOverlayRoot || document.getElementById('immersive-overlay-root');
        if (root) {
            root.classList.toggle('vr-immersive-hide-2d', hidden);
        }
        const menuBar = document.getElementById('menu-bar');
        const chat = document.getElementById('chat-container');
        if (menuBar) {
            menuBar.hidden = hidden;
            menuBar.setAttribute('aria-hidden', hidden ? 'true' : 'false');
        }
        if (chat) {
            chat.hidden = hidden;
            chat.setAttribute('aria-hidden', hidden ? 'true' : 'false');
        }
    }

    _toggleMain() {
        if (this._mainVisible) {
            this._hideAll();
        } else {
            this._mainVisible = true;
            this.root.visible = true;
            this._syncAdminVisibility();
            this._syncToggleStates();
            this.raycast.setTarget(this.root, true);
        }
    }

    _hideAll() {
        this._mainVisible = false;
        this._activePanel = null;
        this.root.visible = false;
        this._closeSubPanels();
        this.raycast.setTarget(null, false);
    }

    _closeSubPanels() {
        this.chatPanel.hide();
        this.stampPanel.hide();
        this.settingsPanel.hide();
        this._removeEphemeralPanel(this._confirmPanel);
        this._removeEphemeralPanel(this._helpPanel);
        this._removeEphemeralPanel(this._adminPanel);
        this._confirmPanel = null;
        this._helpPanel = null;
        this._adminPanel = null;
    }

    /**
     * @param {THREE.Object3D|null} panel
     */
    _removeEphemeralPanel(panel) {
        if (panel?.parent) {
            panel.parent.remove(panel);
        }
    }

    _syncAdminVisibility() {
        const show = this.actions.isAdminVisible();
        const btn = this._menuItems.get('admin');
        if (btn) btn.visible = show;
    }

    _syncToggleStates() {
        const micMuted = this.actions.getMicMuted();
        const spkMuted = this.actions.getSpeakerMuted();
        const micBtn = this._menuItems.get('mic');
        const spkBtn = this._menuItems.get('speaker');
        if (micBtn?.set) {
            micBtn.set({
                backgroundColor: new THREE.Color(micMuted ? VR_UI_COLORS.bgMuted : VR_UI_COLORS.bgActive),
            });
        }
        if (spkBtn?.set) {
            spkBtn.set({
                backgroundColor: new THREE.Color(spkMuted ? VR_UI_COLORS.bgMuted : VR_UI_COLORS.bgActive),
            });
        }
    }

    /**
     * @param {ActivePanelId} panelId
     */
    async _openPanel(panelId) {
        if (this._activePanel === panelId) {
            this._closeSubPanels();
            this._activePanel = null;
            return;
        }

        this._closeSubPanels();
        this._activePanel = panelId;

        if (panelId === 'chat') {
            this.chatPanel.show();
        } else if (panelId === 'stamp') {
            this.stampPanel.show();
        } else if (panelId === 'settings') {
            await this.settingsPanel.show();
        } else if (panelId === 'help') {
            this._showHelpPanel();
        } else if (panelId === 'admin') {
            this._showAdminPanel();
        } else if (panelId === 'restart') {
            this._showConfirmPanel('restart');
        } else if (panelId === 'logout') {
            this._showConfirmPanel('logout');
        }
    }

    _showHelpPanel() {
        this._removeEphemeralPanel(this._helpPanel);
        this._helpPanel = null;
        const panel = createPanelContainer({ width: 1.0, height: 0.65 });
        panel.position.set(0, 0.2, 0);
        panel.add(createPanelTitle(t('vrMenu.help')));
        const closeRow = createRow(0.08);
        closeRow.add(createMenuButton({ width: 0.12, height: 0.07, label: '×', actionId: 'close' }));
        panel.add(closeRow);

        for (const line of this.actions.getHelpLines()) {
            panel.add(createBodyText(line.slice(0, 200)));
        }

        this._helpPanel = panel;
        this.subPanelHost.add(panel);
    }

    _showAdminPanel() {
        this._removeEphemeralPanel(this._adminPanel);
        this._adminPanel = null;
        const panel = createPanelContainer({ width: 0.85, height: 0.45 });
        panel.position.set(0, 0.16, 0);
        panel.add(createPanelTitle(t('adminMenu.title')));
        const toggles = this.actions.getAdminToggles();

        panel.add(createMenuButton({
            width: 0.75,
            height: 0.08,
            label: `${t('adminMenu.invisible')}: ${toggles.invisible ? 'ON' : 'OFF'}`,
            actionId: 'admin-invisible',
        }));
        panel.add(createMenuButton({
            width: 0.75,
            height: 0.08,
            label: `${t('adminMenu.fly')}: ${toggles.fly ? 'ON' : 'OFF'}`,
            actionId: 'admin-fly',
        }));
        panel.add(createMenuButton({
            width: 0.75,
            height: 0.08,
            label: `${t('adminMenu.speed')}: ${toggles.speed ? 'ON' : 'OFF'}`,
            actionId: 'admin-speed',
        }));
        panel.add(createBodyText(t('vrMenu.adminLinkNote')));
        panel.add(createMenuButton({ width: 0.12, height: 0.07, label: '×', actionId: 'close' }));

        this._adminPanel = panel;
        this.subPanelHost.add(panel);
    }

    /**
     * @param {'restart'|'logout'} kind
     */
    _showConfirmPanel(kind) {
        this._removeEphemeralPanel(this._confirmPanel);
        this._confirmPanel = null;
        const panel = createPanelContainer({ width: 0.75, height: 0.32 });
        panel.position.set(0, 0.14, 0);
        const title = kind === 'restart' ? t('restart.title') : t('logout.title');
        const body = kind === 'restart' ? t('vrMenu.restartBody') : t('logout.body');
        panel.add(createPanelTitle(title));
        panel.add(createBodyText(body));

        const row = createRow(0.1);
        row.add(createMenuButton({
            width: 0.3,
            height: 0.08,
            label: kind === 'restart' ? t('restart.confirm') : t('logout.confirm'),
            actionId: 'confirm-yes',
            actionPayload: kind,
        }));
        row.add(createMenuButton({
            width: 0.3,
            height: 0.08,
            label: kind === 'restart' ? t('restart.cancel') : t('logout.lobby'),
            actionId: kind === 'restart' ? 'confirm-no' : 'confirm-lobby',
            actionPayload: kind,
        }));
        panel.add(row);
        panel.add(createMenuButton({ width: 0.12, height: 0.07, label: '×', actionId: 'close' }));

        this._confirmPanel = panel;
        this.subPanelHost.add(panel);
    }

    /**
     * @param {string} action
     * @param {string} payload
     */
    async _handleSelect(action, payload) {
        if (!this._mainVisible) return;

        if (action === 'close') {
            this._closeSubPanels();
            this._activePanel = null;
            return;
        }

        if (this.chatPanel.handleAction(action, payload)) {
            if (action === 'close') {
                this._activePanel = null;
            }
            return;
        }
        if (this.stampPanel.handleAction(action, payload)) {
            if (action === 'close') {
                this._activePanel = null;
            }
            return;
        }
        if (await this.settingsPanel.handleAction(action, payload)) {
            if (action === 'close') {
                this._activePanel = null;
            }
            return;
        }

        if (action === 'admin-invisible') {
            const tgl = this.actions.getAdminToggles();
            this.actions.setAdminInvisible(!tgl.invisible);
            this._showAdminPanel();
            return;
        }
        if (action === 'admin-fly') {
            const tgl = this.actions.getAdminToggles();
            this.actions.setAdminFly(!tgl.fly);
            this._showAdminPanel();
            return;
        }
        if (action === 'admin-speed') {
            const tgl = this.actions.getAdminToggles();
            this.actions.setAdminSpeed(!tgl.speed);
            this._showAdminPanel();
            return;
        }

        if (action === 'confirm-yes') {
            if (payload === 'restart') {
                await this.actions.confirmRestart();
            } else if (payload === 'logout') {
                await this.actions.confirmLogout();
            }
            this._closeSubPanels();
            this._activePanel = null;
            return;
        }
        if (action === 'confirm-no') {
            this._closeSubPanels();
            this._activePanel = null;
            return;
        }
        if (action === 'confirm-lobby') {
            this.actions.confirmReturnToLobby();
            this._closeSubPanels();
            this._activePanel = null;
            return;
        }

        if (action === 'mic') {
            await this.actions.toggleMic();
            this._syncToggleStates();
            return;
        }
        if (action === 'speaker') {
            await this.actions.toggleSpeaker();
            this._syncToggleStates();
            return;
        }

        const panelActions = ['chat', 'stamp', 'settings', 'help', 'admin', 'restart', 'logout'];
        if (panelActions.includes(action)) {
            await this._openPanel(/** @type {ActivePanelId} */ (action));
        }
    }

    _applyLocale() {
        const labels = {
            admin: 'vrMenu.admin',
            mic: 'vrMenu.mic',
            speaker: 'vrMenu.speaker',
            chat: 'vrMenu.chat',
            stamp: 'vrMenu.stamp',
            help: 'vrMenu.help',
            restart: 'vrMenu.restart',
            settings: 'vrMenu.settings',
            logout: 'vrMenu.logout',
        };
        const icons = {
            admin: '🛡', mic: '🎤', speaker: '🔊', chat: '💬', stamp: '😀',
            help: '❓', restart: '🔄', settings: '⚙', logout: '🚪',
        };
        for (const [id, key] of Object.entries(labels)) {
            const btn = this._menuItems.get(id);
            const text = btn?.userData?.vrLabelText;
            if (text?.set) {
                text.set({ content: `${icons[id]}\n${t(key)}` });
            }
        }
        this.chatPanel.applyLocale();
        this.settingsPanel.applyLocale();
    }

    /**
     * カメラのヨー（水平回転）のみ追従
     */
    _syncCameraYaw() {
        if (!this._attached || !this._mainVisible) return;
        this._yawOnly.setFromQuaternion(this.camera.quaternion);
        this._yawOnly.x = 0;
        this._yawOnly.z = 0;
        this.cameraAnchor.quaternion.setFromEuler(this._yawOnly);
    }

    /**
     * @param {number} _deltaTime
     */
    update(_deltaTime) {
        if (!this._attached || !this.renderer.xr.isPresenting) return;

        const session = this.renderer.xr.getSession();
        const { pressed, edge } = pollLeftYButtonEdge(session, this._prevYPressed);
        this._prevYPressed = pressed;
        if (edge) {
            this._toggleMain();
        }

        this._syncCameraYaw();
    }

    dispose() {
        window.removeEventListener('metaverse-locale-changed', this._onLocaleChanged);
        this.detach();
        this.chatPanel.dispose();
        this.stampPanel.dispose();
        this.settingsPanel.dispose();
        this.raycast.dispose();
    }
}

export { ThreeMeshUI };
