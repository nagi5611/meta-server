// addons/webxr-vr/client/vr-ui-helpers.js — three-mesh-ui 共通スタイル

import * as THREE from 'three';
import ThreeMeshUI from 'three-mesh-ui';
import { t } from '../../../public/js/metaverse-i18n.js';
import fontJsonUrl from './assets/font-msdf/Roboto-msdf.json?url';
import fontTextureUrl from './assets/font-msdf/Roboto-msdf.png?url';

/** Vite ビルド時はハッシュ付き URL、開発時も確実に解決 */
export const FONT_JSON = fontJsonUrl;
export const FONT_TEXTURE = fontTextureUrl;

/** @type {'unknown'|'ok'|'fail'} */
let fontProbeStatus = 'unknown';

/**
 * MSDF フォントの取得可否を検査
 * @returns {Promise<'ok'|'fail'>}
 */
export async function probeFontAssets() {
    if (fontProbeStatus === 'ok' || fontProbeStatus === 'fail') {
        return fontProbeStatus;
    }
    try {
        const res = await fetch(FONT_JSON, { method: 'HEAD' });
        fontProbeStatus = res.ok ? 'ok' : 'fail';
    } catch {
        fontProbeStatus = 'fail';
    }
    return fontProbeStatus;
}

/** @typedef {'admin'|'mic'|'speaker'|'chat'|'stamp'|'help'|'restart'|'settings'|'logout'|'close'|'confirm-yes'|'confirm-no'|'chat-send'|'chat-input'|'settings-prev'|'settings-next'|'lang-ja'|'lang-en'|'lang-zh'|'lang-ko'|'lang-zh-tw'|'admin-invisible'|'admin-fly'|'admin-speed'|'stamp-emoji'} VrMenuActionId */

export const VR_UI_COLORS = {
    bg: 0x1a1f28,
    bgHover: 0x2a3548,
    bgActive: 0x0288d1,
    bgMuted: 0x2a2e36,
    text: 0xe8f4fc,
    muted: 0x8899aa,
    danger: 0xc62828,
};

/**
 * MSDF フォントオプション
 * @returns {{ fontFamily: string, fontTexture: string }}
 */
export function getFontOpts() {
    return { fontFamily: FONT_JSON, fontTexture: FONT_TEXTURE };
}

/**
 * three-mesh-ui ボタン Block を生成する
 * @param {object} opts
 * @param {number} opts.width
 * @param {number} opts.height
 * @param {string} opts.label
 * @param {string} opts.actionId
 * @param {string} [opts.actionPayload]
 * @returns {import('three-mesh-ui').Block}
 */
export function createMenuButton({ width, height, label, actionId, actionPayload = '' }) {
    const block = new ThreeMeshUI.Block({
        width,
        height,
        justifyContent: 'center',
        alignItems: 'center',
        backgroundColor: new THREE.Color(VR_UI_COLORS.bg),
        backgroundOpacity: 0.88,
        borderRadius: 0.035,
        margin: 0.012,
        ...getFontOpts(),
    });
    block.userData.vrMenuAction = actionId;
    if (actionPayload) block.userData.vrActionPayload = actionPayload;
    block.userData.vrBaseColor = VR_UI_COLORS.bg;

    const text = new ThreeMeshUI.Text({
        content: label,
        fontSize: 0.032,
        color: new THREE.Color(VR_UI_COLORS.text),
    });
    block.add(text);
    block.userData.vrLabelText = text;
    return block;
}

/**
 * パネル用コンテナ Block
 * @param {object} opts
 * @param {number} opts.width
 * @param {number} opts.height
 * @returns {import('three-mesh-ui').Block}
 */
export function createPanelContainer({ width, height }) {
    const panel = new ThreeMeshUI.Block({
        width,
        height,
        padding: 0.06,
        backgroundColor: new THREE.Color(VR_UI_COLORS.bg),
        backgroundOpacity: 0.92,
        borderRadius: 0.05,
        contentDirection: ThreeMeshUI.ContentDirection.COLUMN,
        alignItems: ThreeMeshUI.AlignItems.STRETCH,
        ...getFontOpts(),
    });
    panel.userData.vrIsPanel = true;
    return panel;
}

/**
 * パネル見出しテキスト
 * @param {string} content
 * @returns {import('three-mesh-ui').Text}
 */
export function createPanelTitle(content) {
    return new ThreeMeshUI.Text({
        content,
        fontSize: 0.045,
        color: new THREE.Color(VR_UI_COLORS.text),
        margin: 0.02,
    });
}

/**
 * 説明テキスト
 * @param {string} content
 * @returns {import('three-mesh-ui').Text}
 */
export function createBodyText(content) {
    return new ThreeMeshUI.Text({
        content,
        fontSize: 0.028,
        color: new THREE.Color(VR_UI_COLORS.muted),
        margin: 0.015,
    });
}

/**
 * 行レイアウト Block
 * @param {number} [height]
 * @returns {import('three-mesh-ui').Block}
 */
export function createRow(height = 0.1) {
    return new ThreeMeshUI.Block({
        width: 1,
        height,
        contentDirection: ThreeMeshUI.ContentDirection.ROW,
        justifyContent: ThreeMeshUI.JustifyContent.START,
        alignItems: ThreeMeshUI.AlignItems.CENTER,
        backgroundOpacity: 0,
        ...getFontOpts(),
    });
}

/**
 * i18n キーでラベルを更新
 * @param {import('three-mesh-ui').Text} textEl
 * @param {string} key
 */
export function setI18nText(textEl, key) {
    if (textEl?.set) {
        textEl.set({ content: t(key) });
    }
}

/**
 * 交差オブジェクトから vrMenuAction を辿る
 * @param {THREE.Object3D|null} obj
 * @returns {{ action: string, payload: string, block: THREE.Object3D|null }}
 */
export function resolveMenuActionFromObject(obj) {
    let cur = obj;
    while (cur) {
        if (cur.userData?.vrMenuAction) {
            return {
                action: String(cur.userData.vrMenuAction),
                payload: String(cur.userData.vrActionPayload || ''),
                block: cur,
            };
        }
        cur = cur.parent;
    }
    return { action: '', payload: '', block: null };
}

/**
 * UI メッシュ一覧を収集
 * @param {THREE.Object3D} root
 * @returns {THREE.Object3D[]}
 */
export function collectUiMeshes(root) {
    /** @type {THREE.Object3D[]} */
    const meshes = [];
    root.traverse((child) => {
        if (child.isMesh && child.visible) {
            meshes.push(child);
        }
    });
    return meshes;
}
