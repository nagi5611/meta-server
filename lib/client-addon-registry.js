// lib/client-addon-registry.js — クライアントアドオン向け拡張点（fail-soft）

/** @typedef {(app: object) => void | Promise<void>} ClientInitFn */
/** @typedef {(app: object, deltaTime: number, timeMs: number, xrFrame?: XRFrame) => void} FrameUpdateFn */
/** @typedef {() => boolean} ImmersiveStateFn */
/** @typedef {(baseTier: 'high'|'medium'|'low') => 'high'|'medium'|'low'|null|undefined} GraphicsTierOverrideFn */
/** @typedef {(computedRatio: number) => number|null|undefined} PixelRatioOverrideFn */

/** @typedef {object} MovementDelegate
 * @property {() => boolean} isActive
 * @property {(deltaTime: number, characterController: object) => void} update
 * @property {() => boolean} [isMoving]
 * @property {() => boolean} [blocksDesktopInput]
 * @property {() => number} [getRigYaw]
 */

/** @type {ClientInitFn[]} */
const clientInits = [];

/** @type {{ fn: FrameUpdateFn, order: number }[]} */
const frameUpdates = [];

/** @type {ImmersiveStateFn[]} */
const immersiveProviders = [];

/** @type {GraphicsTierOverrideFn[]} */
const graphicsTierOverrides = [];

/** @type {PixelRatioOverrideFn[]} */
const pixelRatioOverrides = [];

/** @type {MovementDelegate|null} */
let movementDelegate = null;

/** @type {(() => boolean)|null} */
let inputGuard = null;

/**
 * @param {ClientInitFn} fn
 */
export function registerClientInit(fn) {
    if (typeof fn === 'function') clientInits.push(fn);
}

/**
 * @param {FrameUpdateFn} fn
 * @param {{ order?: number }} [opts]
 */
export function registerFrameUpdate(fn, opts = {}) {
    if (typeof fn !== 'function') return;
    const order = typeof opts.order === 'number' ? opts.order : 0;
    frameUpdates.push({ fn, order });
    frameUpdates.sort((a, b) => a.order - b.order);
}

/**
 * @param {ImmersiveStateFn} fn
 */
export function registerImmersiveStateProvider(fn) {
    if (typeof fn === 'function') immersiveProviders.push(fn);
}

/**
 * @param {GraphicsTierOverrideFn} fn
 */
export function registerGraphicsTierOverride(fn) {
    if (typeof fn === 'function') graphicsTierOverrides.push(fn);
}

/**
 * @param {PixelRatioOverrideFn} fn
 */
export function registerPixelRatioOverride(fn) {
    if (typeof fn === 'function') pixelRatioOverrides.push(fn);
}

/**
 * @param {MovementDelegate|null} delegate
 */
export function registerMovementDelegate(delegate) {
    movementDelegate = delegate && typeof delegate.isActive === 'function'
        && typeof delegate.update === 'function'
        ? delegate
        : null;
}

/**
 * @returns {MovementDelegate|null}
 */
export function getMovementDelegate() {
    return movementDelegate;
}

/**
 * @param {(() => boolean)|null} fn
 */
export function registerInputGuard(fn) {
    inputGuard = typeof fn === 'function' ? fn : null;
}

/**
 * @returns {(() => boolean)|null}
 */
export function getInputGuard() {
    return inputGuard;
}

/**
 * @returns {boolean}
 */
export function getImmersiveState() {
    for (const fn of immersiveProviders) {
        try {
            if (fn()) return true;
        } catch (e) {
            console.error('[client-addon-registry] immersive provider failed:', e);
        }
    }
    return false;
}

/**
 * @param {'high'|'medium'|'low'} baseTier
 * @returns {'high'|'medium'|'low'}
 */
export function resolveGraphicsTier(baseTier) {
    for (const fn of graphicsTierOverrides) {
        try {
            const t = fn(baseTier);
            if (t === 'high' || t === 'medium' || t === 'low') return t;
        } catch (e) {
            console.error('[client-addon-registry] graphics tier override failed:', e);
        }
    }
    return baseTier;
}

/**
 * @param {number} computedRatio
 * @returns {number}
 */
export function resolvePixelRatio(computedRatio) {
    for (const fn of pixelRatioOverrides) {
        try {
            const v = fn(computedRatio);
            if (typeof v === 'number' && Number.isFinite(v)) return v;
        } catch (e) {
            console.error('[client-addon-registry] pixel ratio override failed:', e);
        }
    }
    return computedRatio;
}

/**
 * @param {object} app
 * @returns {Promise<void>}
 */
export async function runClientInits(app) {
    for (const fn of clientInits) {
        try {
            await fn(app);
        } catch (e) {
            console.error('[client-addon-registry] client init failed:', e);
        }
    }
}

/**
 * @param {object} app
 * @param {number} deltaTime
 * @param {number} timeMs
 * @param {XRFrame} [xrFrame]
 */
export function runFrameUpdates(app, deltaTime, timeMs, xrFrame) {
    for (const { fn } of frameUpdates) {
        try {
            fn(app, deltaTime, timeMs, xrFrame);
        } catch (e) {
            console.error('[client-addon-registry] frame update failed:', e);
        }
    }
}

/**
 * アドオンサブシステムの破棄（beforeunload 等）
 * @param {object} app
 */
export function runClientDisposes(app) {
    if (typeof app._webxrVrDispose === 'function') {
        try {
            app._webxrVrDispose();
        } catch (e) {
            console.error('[client-addon-registry] webxr dispose failed:', e);
        }
    }
}
