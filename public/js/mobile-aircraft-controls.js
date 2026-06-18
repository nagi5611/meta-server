/**
 * mobile-aircraft-controls.js — Easy 飛行機操縦向けモバイル UI（デュアルスティック・推力ボタン・視線ドラッグ）
 */

import nipplejs from 'nipplejs';
import { isMobile } from './mobile-utils.js';

const DEADZONE = 0.35;
const STICK_SIZE = 130;

class MobileAircraftControls {
    constructor() {
        this.aircraftController = null;
        this.leftManager = null;
        this.rightManager = null;
        this.container = null;
        this.cameraDragLayer = null;
        this.lastTouchX = 0;
        this.lastTouchY = 0;
        this.isCameraDragging = false;
        this.cameraTouchId = null;
        this.boundTouchStart = null;
        this.boundTouchMove = null;
        this.boundTouchEnd = null;
        /** @type {Partial<Record<'forward'|'back'|'yawL'|'yawR'|'pitchUp'|'pitchDn'|'rollL'|'rollR'|'brake', boolean>>} */
        this._stickKeys = {};
        this._buttonKeys = { forward: false, back: false, brake: false };
        this._buttonHandlers = [];
    }

    /**
     * @param {import('../../addons/aircraft/client/aircraft-controller.js').default} aircraftController
     */
    init(aircraftController) {
        if (!isMobile()) return;

        this.destroy();
        this.aircraftController = aircraftController;

        this.container = document.getElementById('mobile-aircraft-controls');
        const leftZone = document.getElementById('aircraft-joystick-left-zone');
        const rightZone = document.getElementById('aircraft-joystick-right-zone');
        this.cameraDragLayer = document.getElementById('aircraft-camera-drag-layer');
        const accelBtn = document.getElementById('aircraft-accel-btn');
        const decelBtn = document.getElementById('aircraft-decel-btn');
        const brakeBtn = document.getElementById('aircraft-brake-btn');

        if (!leftZone || !rightZone || !this.cameraDragLayer) return;

        this.leftManager = nipplejs.create({
            zone: leftZone,
            mode: 'static',
            position: { left: '50%', bottom: '50%' },
            size: STICK_SIZE,
            color: 'rgba(255,255,255,0.6)',
            restOpacity: 0.5,
        });

        this.rightManager = nipplejs.create({
            zone: rightZone,
            mode: 'static',
            position: { left: '50%', bottom: '50%' },
            size: STICK_SIZE,
            color: 'rgba(255,255,255,0.6)',
            restOpacity: 0.5,
        });

        this.leftManager.on('move', (_evt, data) => {
            this._onLeftStick(data);
        });
        this.leftManager.on('end', () => {
            this._stickKeys = { ...this._stickKeys, forward: false, back: false, yawL: false, yawR: false };
            this._syncTouchInput();
        });

        this.rightManager.on('move', (_evt, data) => {
            this._onRightStick(data);
        });
        this.rightManager.on('end', () => {
            this._stickKeys = {
                ...this._stickKeys,
                pitchUp: false,
                pitchDn: false,
                rollL: false,
                rollR: false,
            };
            this._syncTouchInput();
        });

        this._bindHoldButton(accelBtn, 'forward');
        this._bindHoldButton(decelBtn, 'back');
        this._bindHoldButton(brakeBtn, 'brake');

        this.boundTouchStart = (e) => this.onCameraTouchStart(e);
        this.boundTouchMove = (e) => this.onCameraTouchMove(e);
        this.boundTouchEnd = (e) => this.onCameraTouchEnd(e);

        this.cameraDragLayer.addEventListener('touchstart', this.boundTouchStart, { passive: true });
        this.cameraDragLayer.addEventListener('touchmove', this.boundTouchMove, { passive: false });
        this.cameraDragLayer.addEventListener('touchend', this.boundTouchEnd, { passive: true });
        this.cameraDragLayer.addEventListener('touchcancel', this.boundTouchEnd, { passive: true });
    }

    /**
     * @param {HTMLElement|null} btn
     * @param {'forward'|'back'|'brake'} key
     */
    _bindHoldButton(btn, key) {
        if (!btn) return;
        const onStart = (e) => {
            e.preventDefault();
            this._buttonKeys[key] = true;
            this._syncTouchInput();
        };
        const onEnd = (e) => {
            e.preventDefault();
            this._buttonKeys[key] = false;
            this._syncTouchInput();
        };
        btn.addEventListener('touchstart', onStart, { passive: false });
        btn.addEventListener('touchend', onEnd, { passive: false });
        btn.addEventListener('touchcancel', onEnd, { passive: false });
        btn.addEventListener('mousedown', onStart);
        btn.addEventListener('mouseup', onEnd);
        btn.addEventListener('mouseleave', onEnd);
        this._buttonHandlers.push({ btn, onStart, onEnd });
    }

    /**
     * @param {{ vector?: { x: number, y: number } }} data
     */
    _onLeftStick(data) {
        const v = data.vector;
        if (!v) return;
        this._stickKeys = {
            ...this._stickKeys,
            forward: v.y > DEADZONE,
            back: v.y < -DEADZONE,
            yawL: v.x < -DEADZONE,
            yawR: v.x > DEADZONE,
        };
        this._syncTouchInput();
    }

    /**
     * @param {{ vector?: { x: number, y: number } }} data
     */
    _onRightStick(data) {
        const v = data.vector;
        if (!v) return;
        this._stickKeys = {
            ...this._stickKeys,
            pitchUp: v.y > DEADZONE,
            pitchDn: v.y < -DEADZONE,
            rollL: v.x < -DEADZONE,
            rollR: v.x > DEADZONE,
        };
        this._syncTouchInput();
    }

    _syncTouchInput() {
        if (!this.aircraftController) return;
        this.aircraftController.setTouchInput({
            forward: !!(this._stickKeys.forward || this._buttonKeys.forward),
            back: !!(this._stickKeys.back || this._buttonKeys.back),
            yawL: !!this._stickKeys.yawL,
            yawR: !!this._stickKeys.yawR,
            pitchUp: !!this._stickKeys.pitchUp,
            pitchDn: !!this._stickKeys.pitchDn,
            rollL: !!this._stickKeys.rollL,
            rollR: !!this._stickKeys.rollR,
            brake: !!this._buttonKeys.brake,
        });
    }

    onCameraTouchStart(e) {
        if (e.changedTouches.length === 0) return;
        const touch = e.changedTouches[0];
        this.cameraTouchId = touch.identifier;
        this.isCameraDragging = true;
        this.lastTouchX = touch.clientX;
        this.lastTouchY = touch.clientY;
    }

    onCameraTouchMove(e) {
        if (!this.isCameraDragging || this.cameraTouchId == null || !this.aircraftController) return;
        const touch = Array.from(e.touches).find((t) => t.identifier === this.cameraTouchId);
        if (!touch) return;
        e.preventDefault();
        const dx = touch.clientX - this.lastTouchX;
        const dy = touch.clientY - this.lastTouchY;
        this.lastTouchX = touch.clientX;
        this.lastTouchY = touch.clientY;
        this.aircraftController.addPilotLookDelta(dx, dy);
    }

    onCameraTouchEnd(e) {
        if (e.changedTouches) {
            const ourTouch = Array.from(e.changedTouches).find((t) => t.identifier === this.cameraTouchId);
            if (ourTouch) {
                this.isCameraDragging = false;
                this.cameraTouchId = null;
            }
        } else {
            this.isCameraDragging = false;
            this.cameraTouchId = null;
        }
    }

    show() {
        const el = document.getElementById('mobile-aircraft-controls');
        if (el) el.setAttribute('aria-hidden', 'false');
    }

    hide() {
        const el = document.getElementById('mobile-aircraft-controls');
        if (el) el.setAttribute('aria-hidden', 'true');
    }

    destroy() {
        for (const { btn, onStart, onEnd } of this._buttonHandlers) {
            btn.removeEventListener('touchstart', onStart);
            btn.removeEventListener('touchend', onEnd);
            btn.removeEventListener('touchcancel', onEnd);
            btn.removeEventListener('mousedown', onStart);
            btn.removeEventListener('mouseup', onEnd);
            btn.removeEventListener('mouseleave', onEnd);
        }
        this._buttonHandlers = [];
        this._stickKeys = {};
        this._buttonKeys = { forward: false, back: false, brake: false };

        if (this.cameraDragLayer && this.boundTouchStart) {
            this.cameraDragLayer.removeEventListener('touchstart', this.boundTouchStart);
            this.cameraDragLayer.removeEventListener('touchmove', this.boundTouchMove);
            this.cameraDragLayer.removeEventListener('touchend', this.boundTouchEnd);
            this.cameraDragLayer.removeEventListener('touchcancel', this.boundTouchEnd);
        }
        this.cameraDragLayer = null;
        this.boundTouchStart = null;
        this.boundTouchMove = null;
        this.boundTouchEnd = null;
        this.isCameraDragging = false;
        this.cameraTouchId = null;

        if (this.leftManager) {
            this.leftManager.destroy();
            this.leftManager = null;
        }
        if (this.rightManager) {
            this.rightManager.destroy();
            this.rightManager = null;
        }

        if (this.aircraftController) {
            this.aircraftController.setTouchInput({
                forward: false,
                back: false,
                yawL: false,
                yawR: false,
                pitchUp: false,
                pitchDn: false,
                rollL: false,
                rollR: false,
                brake: false,
            });
        }
        this.aircraftController = null;
        this.container = null;
    }
}

export default new MobileAircraftControls();
