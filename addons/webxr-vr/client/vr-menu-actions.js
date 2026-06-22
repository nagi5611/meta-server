// addons/webxr-vr/client/vr-menu-actions.js — MenuManager / ChatManager 委譲

/**
 * VR メニューから既存 Manager へ操作を委譲するファサード
 */
export class VrMenuActions {
    /**
     * @param {object} app MetaverseApp
     */
    constructor(app) {
        this.app = app;
    }

    /** @returns {import('../../../public/js/menu-manager.js').default|null} */
    get menu() {
        return this.app.menuManager || null;
    }

    /** @returns {import('../../../public/js/chat-manager.js').default|null} */
    get chat() {
        return this.app.chatManager || null;
    }

    async toggleMic() {
        await this.menu?.toggleMic();
    }

    async toggleSpeaker() {
        await this.menu?.toggleSpeaker();
    }

    getMicMuted() {
        if (!this.menu) return true;
        if (typeof this.menu.getMicMuted === 'function') return this.menu.getMicMuted();
        return !!this.menu.isMicMuted;
    }

    getSpeakerMuted() {
        if (!this.menu) return false;
        if (typeof this.menu.getSpeakerMuted === 'function') return this.menu.getSpeakerMuted();
        return !!this.menu.isSpeakerMuted;
    }

    isAdminVisible() {
        return !!this.menu?.isAdminVisible?.();
    }

    getSettings() {
        return this.menu?.getSettings?.() ?? { ...this.menu?.settings };
    }

    /**
     * @param {string} key
     * @param {unknown} value
     */
    applySetting(key, value) {
        this.menu?.applySetting?.(key, value);
    }

    async getAudioDevices() {
        return this.menu?.getAudioDevices?.() ?? { mics: [], speakers: [] };
    }

    getHelpLines() {
        return this.menu?.getHelpLinesForVr?.() ?? [];
    }

    openRestartConfirm() {
        return true;
    }

    async confirmRestart() {
        await this.menu?.handleRestartWorldConfirm?.();
    }

    confirmReturnToLobby() {
        this.menu?.returnToLobby?.();
    }

    async confirmLogout() {
        await this.menu?.logout?.();
    }

    setAdminInvisible(enabled) {
        this.menu?.setAdminInvisible?.(enabled);
    }

    setAdminFly(enabled) {
        this.menu?.setAdminFly?.(enabled);
    }

    setAdminSpeed(enabled) {
        this.menu?.setAdminSpeed?.(enabled);
    }

    getAdminToggles() {
        return this.menu?.getAdminToggles?.() ?? { invisible: false, fly: false, speed: false };
    }

    /**
     * @param {string} text
     */
    sendChatMessage(text) {
        const trimmed = String(text || '').trim();
        if (!trimmed) return;
        this.chat?.sendMessage(trimmed);
    }

    /**
     * @param {string} emoji
     */
    sendEmoji(emoji) {
        this.chat?.sendEmoji(emoji);
    }

    /** @returns {string[]} */
    getEmojiList() {
        return this.chat?.emojiList ? [...this.chat.emojiList] : [];
    }

    getChatMessagesSnapshot() {
        return this.chat?.getMessagesSnapshot?.() ?? [];
    }

    /**
     * @param {() => void} fn
     * @returns {() => void}
     */
    onChatMessagesChanged(fn) {
        return this.chat?.onMessagesChanged?.(fn) ?? (() => {});
    }

    warnIfVideoStreamingInVr() {
        const vcm = this.menu?.videoChatManager;
        if (vcm?.isStreaming || vcm?.isPublishing) {
            console.warn('[VR] Video streaming is active. Consider stopping before VR immersion.');
        }
    }
}
