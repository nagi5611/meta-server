// lib/hook-registry.js — addon 用フック登録（単一プロセス内）

/** @typedef {Record<string, unknown>} HookPayload */

export class HookRegistry {
    constructor() {
        /** @type {Map<string, Array<(p: HookPayload) => void | Promise<void>>>} */
        this._handlers = new Map();
    }

    /**
     * フックを登録する
     * @param {string} name
     * @param {(payload: HookPayload) => void | Promise<void>} fn
     */
    on(name, fn) {
        if (!this._handlers.has(name)) this._handlers.set(name, []);
        this._handlers.get(name).push(fn);
    }

    /**
     * 同期連鎖（express 登録など）。ハンドラは順に実行するが await しない。
     * @param {string} name
     * @param {HookPayload} payload
     */
    emitSync(name, payload) {
        const list = this._handlers.get(name);
        if (!list?.length) return;
        for (const fn of list) {
            try {
                fn(payload);
            } catch (e) {
                console.error(`[hooks] emitSync(${name}) error:`, e);
            }
        }
    }

    /**
     * 非同期連鎖（shutdown など）
     * @param {string} name
     * @param {HookPayload} payload
     */
    async emitAsync(name, payload) {
        const list = this._handlers.get(name);
        if (!list?.length) return;
        for (const fn of list) {
            try {
                await fn(payload);
            } catch (e) {
                console.error(`[hooks] emitAsync(${name}) error:`, e);
            }
        }
    }
}

/** @type {HookRegistry | null} */
let singleton = null;

export function getHookRegistry() {
    if (!singleton) singleton = new HookRegistry();
    return singleton;
}

/** コアと addon が共有するフック名 */
export const HOOKS = Object.freeze({
    EXPRESS_SETUP: 'express:setup',
    SOCKET_SETUP: 'socket:setup',
    SHUTDOWN: 'shutdown',
});
