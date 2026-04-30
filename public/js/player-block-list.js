// public/js/player-block-list.js
/** localStorage キー: ローカルブロック済みプレイヤー ID（Socket id） */
const STORAGE_KEY = 'metaverse-blocked-player-ids';

/**
 * ローカルクライアントのブロック一覧（永続化）
 */
export default class PlayerBlockList {
    constructor() {
        /** @type {Set<string>} */
        this._ids = new Set();
        this._load();
    }

    /** @returns {string[]} */
    _readStorageRaw() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (!raw) return [];
            const arr = JSON.parse(raw);
            return Array.isArray(arr) ? arr : [];
        } catch (_) {
            return [];
        }
    }

    _load() {
        this._ids.clear();
        for (const id of this._readStorageRaw()) {
            if (id != null && String(id).trim()) {
                this._ids.add(String(id));
            }
        }
    }

    _save() {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify([...this._ids]));
        } catch (e) {
            console.warn('[PlayerBlockList] save failed', e);
        }
    }

    /**
     * @param {string|null|undefined} id
     * @returns {boolean}
     */
    has(id) {
        if (id == null || id === '') return false;
        return this._ids.has(String(id));
    }

    /**
     * @param {string|null|undefined} id
     */
    add(id) {
        if (id == null || id === '') return;
        this._ids.add(String(id));
        this._save();
    }

    /**
     * @param {string|null|undefined} id
     */
    remove(id) {
        if (id == null || id === '') return;
        this._ids.delete(String(id));
        this._save();
    }
}
