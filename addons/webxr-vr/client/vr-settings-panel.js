// addons/webxr-vr/client/vr-settings-panel.js — VR 設定パネル

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
import { VIEW_DISTANCE_SLIDER_STEPS } from '../../../public/js/ibl-setup.js';

/** @typedef {'general'|'audio'|'draw'} SettingsSection */

/**
 * VR 設定パネル（#settings-modal 相当）
 */
export class VrSettingsPanel {
    /**
     * @param {import('./vr-menu-actions.js').VrMenuActions} actions
     */
    constructor(actions) {
        this.actions = actions;
        this.root = new THREE.Group();
        this.root.name = 'vr-settings-panel';
        this.root.visible = false;

        /** @type {SettingsSection} */
        this._section = 'general';
        this._contentBlock = null;
        this._titleText = null;
        this._audioDevices = { mics: [], speakers: [] };

        this._buildUi();
    }

    _buildUi() {
        const panel = createPanelContainer({ width: 1.15, height: 0.78 });
        panel.position.set(0, 0.24, 0);

        const titleRow = createRow(0.09);
        this._titleText = createPanelTitle(t('vrMenu.settings'));
        titleRow.add(this._titleText);
        titleRow.add(createMenuButton({
            width: 0.1,
            height: 0.08,
            label: '×',
            actionId: 'close',
        }));
        panel.add(titleRow);

        const tabs = createRow(0.08);
        for (const sec of /** @type {SettingsSection[]} */ (['general', 'audio', 'draw'])) {
            tabs.add(createMenuButton({
                width: 0.28,
                height: 0.07,
                label: t(`settings.cat.${sec}`),
                actionId: 'settings-section',
                actionPayload: sec,
            }));
        }
        panel.add(tabs);

        this._contentBlock = new ThreeMeshUI.Block({
            width: 1,
            height: 0.52,
            padding: 0.03,
            contentDirection: ThreeMeshUI.ContentDirection.COLUMN,
            alignItems: ThreeMeshUI.AlignItems.STRETCH,
            backgroundColor: new THREE.Color(0x0d1117),
            backgroundOpacity: 0.6,
            borderRadius: 0.03,
            ...getFontOpts(),
        });
        panel.add(this._contentBlock);
        this.root.add(panel);
    }

    async _loadAudioDevices() {
        this._audioDevices = await this.actions.getAudioDevices();
    }

    /**
     * 設定行（ラベル + 値 + 操作ボタン）
     * @param {string} label
     * @param {string} value
     * @param {string} minusAction
     * @param {string} plusAction
     * @param {string} [note]
     */
    _addSettingRow(label, value, minusAction, plusAction, note = '') {
        const row = createRow(0.11);
        row.add(createBodyText(`${label}: ${value}`));
        if (minusAction) {
            row.add(createMenuButton({ width: 0.08, height: 0.07, label: '−', actionId: minusAction }));
        }
        if (plusAction) {
            row.add(createMenuButton({ width: 0.08, height: 0.07, label: '+', actionId: plusAction }));
        }
        this._contentBlock.add(row);
        if (note) {
            this._contentBlock.add(createBodyText(note));
        }
    }

    _addDisabledRow(label, note) {
        const row = createRow(0.1);
        row.add(createBodyText(`${label}`));
        this._contentBlock.add(row);
        this._contentBlock.add(createBodyText(note || t('vrMenu.notAvailableInVr')));
    }

    _clearContent() {
        if (!this._contentBlock) return;
        while (this._contentBlock.children.length > 0) {
            this._contentBlock.remove(this._contentBlock.children[0]);
        }
    }

    async _renderSection() {
        this._clearContent();
        const s = this.actions.getSettings() || {};

        if (this._section === 'general') {
            this._contentBlock.add(createBodyText(t('settings.languageLabel')));
            const langKeys = {
                ja: 'settings.langJa',
                en: 'settings.langEn',
                zh: 'settings.langZh',
                ko: 'settings.langKo',
                'zh-tw': 'settings.langZhTw',
            };
            const langRow1 = createRow(0.09);
            for (const loc of ['ja', 'en', 'zh']) {
                langRow1.add(createMenuButton({
                    width: 0.22,
                    height: 0.07,
                    label: t(langKeys[loc]),
                    actionId: `lang-${loc}`,
                }));
            }
            this._contentBlock.add(langRow1);
            const langRow2 = createRow(0.09);
            for (const loc of ['ko', 'zh-tw']) {
                langRow2.add(createMenuButton({
                    width: 0.22,
                    height: 0.07,
                    label: t(langKeys[loc]),
                    actionId: `lang-${loc}`,
                }));
            }
            this._contentBlock.add(langRow2);
            this._contentBlock.add(createBodyText(`${t('settings.languageHint')} (${s.language || 'ja'})`));
            return;
        }

        if (this._section === 'audio') {
            this._addDisabledRow(t('settings.micTestLabel'), t('vrMenu.notAvailableInVr'));

            const micNames = this._audioDevices.mics.map((d) => d.label).join(' / ') || t('settings.defaultDevice');
            this._contentBlock.add(createBodyText(`${t('settings.micDeviceLabel')}: ${micNames}`));
            this._contentBlock.add(createMenuButton({
                width: 0.5,
                height: 0.07,
                label: t('vrMenu.cycleMic'),
                actionId: 'cycle-mic-device',
            }));

            const spkNames = this._audioDevices.speakers.map((d) => d.label).join(' / ') || t('settings.defaultDevice');
            this._contentBlock.add(createBodyText(`${t('settings.speakerDeviceLabel')}: ${spkNames}`));
            this._contentBlock.add(createMenuButton({
                width: 0.5,
                height: 0.07,
                label: t('vrMenu.cycleSpeaker'),
                actionId: 'cycle-speaker-device',
            }));

            this._addSettingRow(
                t('settings.micVolumeLabel'),
                `${(s.micVolume ?? 33) * 3}%`,
                'mic-vol-down',
                'mic-vol-up'
            );
            this._addSettingRow(
                t('settings.speakerVolumeLabel'),
                `${s.speakerVolume ?? 50}%`,
                'speaker-vol-down',
                'speaker-vol-up'
            );
            return;
        }

        if (this._section === 'draw') {
            this._addSettingRow(
                t('settings.viewDistanceLabel'),
                `${Math.round(s.viewDistanceM ?? 50)}m`,
                'view-dist-down',
                'view-dist-up'
            );

            this._addDisabledRow(
                t('settings.viewModeLabel'),
                t('vrMenu.viewModeVrNote')
            );

            const hcOn = s.visualMode === 'highContrast';
            this._contentBlock.add(createMenuButton({
                width: 0.7,
                height: 0.07,
                label: `${t('settings.visualModeLabel')}: ${hcOn ? 'ON' : 'OFF'}`,
                actionId: 'toggle-high-contrast',
            }));

            this._contentBlock.add(createBodyText(`${t('settings.graphicsTierLabel')}: ${s.graphicsTier} (${t('vrMenu.graphicsVrNote')})`));
            this._contentBlock.add(createMenuButton({
                width: 0.5,
                height: 0.07,
                label: t('vrMenu.cycleGraphics'),
                actionId: 'cycle-graphics',
            }));

            this._addSettingRow(
                t('settings.exposureLabel'),
                Number(s.toneMappingExposure ?? 1).toFixed(2),
                'exposure-down',
                'exposure-up'
            );

            this._contentBlock.add(createBodyText(`${t('settings.pixelRatioLabel')}: ${s.pixelRatioCap} (${t('vrMenu.pixelRatioVrNote')})`));

            const showRange = !!s.showViewRangeSpheres;
            this._contentBlock.add(createMenuButton({
                width: 0.8,
                height: 0.07,
                label: `${t('settings.showViewRangeLabel')}: ${showRange ? 'ON' : 'OFF'}`,
                actionId: 'toggle-view-range',
            }));

            this._contentBlock.add(createBodyText(t('vrMenu.proModeVrNote')));
            const proOn = !!s.proMode;
            this._contentBlock.add(createMenuButton({
                width: 0.6,
                height: 0.07,
                label: `${t('settings.proModeLabel')}: ${proOn ? 'ON' : 'OFF'}`,
                actionId: 'toggle-pro-mode',
            }));

            const devOn = !!s.developerMode;
            this._contentBlock.add(createMenuButton({
                width: 0.7,
                height: 0.07,
                label: `${t('settings.developerModeLabel')}: ${devOn ? 'ON' : 'OFF'}`,
                actionId: 'toggle-developer',
            }));
        }
    }

    async show() {
        await this._loadAudioDevices();
        this.root.visible = true;
        await this._renderSection();
    }

    hide() {
        this.root.visible = false;
    }

    /**
     * @param {string} action
     * @param {string} payload
     * @returns {boolean}
     */
    async handleAction(action, payload) {
        if (!this.root.visible) return false;
        if (action === 'close') return true;

        const s = this.actions.getSettings() || {};

        if (action === 'settings-section' && payload) {
            this._section = /** @type {SettingsSection} */ (payload);
            await this._renderSection();
            return true;
        }

        if (action === 'lang-ja') { this.actions.applySetting('language', 'ja'); await this._renderSection(); return true; }
        if (action === 'lang-en') { this.actions.applySetting('language', 'en'); await this._renderSection(); return true; }
        if (action === 'lang-zh') { this.actions.applySetting('language', 'zh'); await this._renderSection(); return true; }
        if (action === 'lang-ko') { this.actions.applySetting('language', 'ko'); await this._renderSection(); return true; }
        if (action === 'lang-zh-tw') { this.actions.applySetting('language', 'zh-tw'); await this._renderSection(); return true; }

        if (action === 'cycle-mic-device') {
            const list = [{ deviceId: '', label: t('settings.defaultDevice') }, ...this._audioDevices.mics];
            const idx = list.findIndex((d) => d.deviceId === (s.micDevice || ''));
            const next = list[(idx + 1) % list.length];
            this.actions.applySetting('micDevice', next.deviceId);
            await this._renderSection();
            return true;
        }
        if (action === 'cycle-speaker-device') {
            const list = [{ deviceId: '', label: t('settings.defaultDevice') }, ...this._audioDevices.speakers];
            const idx = list.findIndex((d) => d.deviceId === (s.speakerDevice || ''));
            const next = list[(idx + 1) % list.length];
            this.actions.applySetting('speakerDevice', next.deviceId);
            await this._renderSection();
            return true;
        }
        if (action === 'mic-vol-down') {
            this.actions.applySetting('micVolume', Math.max(0, (s.micVolume ?? 33) - 5));
            await this._renderSection();
            return true;
        }
        if (action === 'mic-vol-up') {
            this.actions.applySetting('micVolume', Math.min(100, (s.micVolume ?? 33) + 5));
            await this._renderSection();
            return true;
        }
        if (action === 'speaker-vol-down') {
            this.actions.applySetting('speakerVolume', Math.max(0, (s.speakerVolume ?? 50) - 5));
            await this._renderSection();
            return true;
        }
        if (action === 'speaker-vol-up') {
            this.actions.applySetting('speakerVolume', Math.min(100, (s.speakerVolume ?? 50) + 5));
            await this._renderSection();
            return true;
        }

        if (action === 'view-dist-down' || action === 'view-dist-up') {
            const steps = VIEW_DISTANCE_SLIDER_STEPS;
            const cur = Math.round(s.viewDistanceM ?? 50);
            let bestIdx = 0;
            let bestDiff = Infinity;
            for (let i = 0; i < steps.length; i++) {
                const d = Math.abs(steps[i] - cur);
                if (d < bestDiff) { bestDiff = d; bestIdx = i; }
            }
            const nextIdx = action === 'view-dist-up'
                ? Math.min(steps.length - 1, bestIdx + 1)
                : Math.max(0, bestIdx - 1);
            this.actions.applySetting('viewDistanceM', steps[nextIdx]);
            await this._renderSection();
            return true;
        }

        if (action === 'toggle-high-contrast') {
            this.actions.applySetting('visualMode', s.visualMode === 'highContrast' ? 'standard' : 'highContrast');
            await this._renderSection();
            return true;
        }
        if (action === 'cycle-graphics') {
            const order = ['low', 'medium', 'high'];
            const idx = order.indexOf(s.graphicsTier || 'low');
            this.actions.applySetting('graphicsTier', order[(idx + 1) % order.length]);
            await this._renderSection();
            return true;
        }
        if (action === 'exposure-down') {
            this.actions.applySetting('toneMappingExposure', Math.max(0.2, (s.toneMappingExposure ?? 1) - 0.1));
            await this._renderSection();
            return true;
        }
        if (action === 'exposure-up') {
            this.actions.applySetting('toneMappingExposure', Math.min(3, (s.toneMappingExposure ?? 1) + 0.1));
            await this._renderSection();
            return true;
        }
        if (action === 'toggle-view-range') {
            this.actions.applySetting('showViewRangeSpheres', !s.showViewRangeSpheres);
            await this._renderSection();
            return true;
        }
        if (action === 'toggle-pro-mode') {
            this.actions.applySetting('proMode', !s.proMode);
            await this._renderSection();
            return true;
        }
        if (action === 'toggle-developer') {
            this.actions.applySetting('developerMode', !s.developerMode);
            await this._renderSection();
            return true;
        }

        return false;
    }

    applyLocale() {
        if (this._titleText?.set) {
            this._titleText.set({ content: t('vrMenu.settings') });
        }
    }

    dispose() {
        /* noop */
    }
}
