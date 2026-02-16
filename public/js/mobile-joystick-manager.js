/**
 * mobile-joystick-manager.js - nipplejs による仮想スティック制御とドラッグによるカメラ操作
 */

import nipplejs from 'nipplejs';
import { isMobile } from './mobile-utils.js';

const CAMERA_SENSITIVITY = 0.008;

class MobileJoystickManager {
    constructor() {
        this.leftManager = null;
        this.characterController = null;
        this.jumpHandler = null;
        this.jumpClickHandler = null;
        this.jumpTouchHandler = null;
        this.cameraDragLayer = null;
        this.lastTouchX = 0;
        this.lastTouchY = 0;
        this.isCameraDragging = false;
        this.boundTouchStart = null;
        this.boundTouchMove = null;
        this.boundTouchEnd = null;
        this.cameraTouchId = null;
    }

    /**
     * 768px以下のときのみ初期化
     * @param {CharacterController} characterController
     */
    init(characterController) {
        if (!isMobile()) return;

        this.destroy();

        this.characterController = characterController;

        const leftZone = document.getElementById('joystick-left-zone');
        const jumpBtn = document.getElementById('mobile-jump-btn');
        const cameraDragLayer = document.getElementById('mobile-camera-drag-layer');

        if (!leftZone || !jumpBtn || !cameraDragLayer) return;

        // 左スティック: 移動
        this.leftManager = nipplejs.create({
            zone: leftZone,
            mode: 'static',
            position: { left: '50%', bottom: '50%' },
            size: 120,
            color: 'rgba(255,255,255,0.6)',
            restOpacity: 0.5
        });

        this.leftManager.on('move', (evt, data) => {
            if (data.vector) {
                characterController.setMobileMove({
                    x: data.vector.x,
                    y: data.vector.y,
                    force: typeof data.force === 'number' ? data.force : 1
                });
            }
        });

        this.leftManager.on('end', () => {
            characterController.setMobileMove({ x: 0, y: 0, force: 0 });
        });

        // ドラッグ: カメラ回転（スティック・ジャンプボタン以外の領域）
        this.cameraDragLayer = cameraDragLayer;
        this.boundTouchStart = (e) => this.onCameraTouchStart(e);
        this.boundTouchMove = (e) => this.onCameraTouchMove(e);
        this.boundTouchEnd = (e) => this.onCameraTouchEnd(e);

        cameraDragLayer.addEventListener('touchstart', this.boundTouchStart, { passive: true });
        cameraDragLayer.addEventListener('touchmove', this.boundTouchMove, { passive: false });
        cameraDragLayer.addEventListener('touchend', this.boundTouchEnd, { passive: true });
        cameraDragLayer.addEventListener('touchcancel', this.boundTouchEnd, { passive: true });

        // ジャンプボタン（移動中でも押せる・touchendでモバイル反応を確実に）
        let lastJumpTime = 0;
        const doJump = () => {
            const now = Date.now();
            if (now - lastJumpTime < 250) return;
            lastJumpTime = now;
            characterController.triggerJump();
        };
        const onClick = (e) => {
            e.preventDefault();
            e.stopPropagation();
            doJump();
        };
        const onTouchEnd = (e) => {
            e.preventDefault();
            doJump();
        };
        this.jumpClickHandler = onClick;
        this.jumpTouchHandler = onTouchEnd;
        this.jumpHandler = doJump;

        jumpBtn.addEventListener('click', onClick);
        jumpBtn.addEventListener('touchend', onTouchEnd, { passive: false });
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
        if (!this.isCameraDragging || this.cameraTouchId == null || !this.characterController) return;
        const touch = Array.from(e.touches).find((t) => t.identifier === this.cameraTouchId);
        if (!touch) return;
        e.preventDefault();
        const dx = touch.clientX - this.lastTouchX;
        const dy = touch.clientY - this.lastTouchY;
        this.lastTouchX = touch.clientX;
        this.lastTouchY = touch.clientY;
        this.characterController.addMobileCameraDelta(dx * CAMERA_SENSITIVITY, dy * CAMERA_SENSITIVITY);
    }

    onCameraTouchEnd(e) {
        if (e.changedTouches) {
            const ourTouch = Array.from(e.changedTouches).find((t) => t.identifier === this.cameraTouchId);
            if (ourTouch) {
                this.isCameraDragging = false;
                this.cameraTouchId = null;
                if (this.characterController) {
                    this.characterController.resetMobileCameraDelta();
                }
            }
        } else {
            this.isCameraDragging = false;
            this.cameraTouchId = null;
            if (this.characterController) {
                this.characterController.resetMobileCameraDelta();
            }
        }
    }

    destroy() {
        const jumpBtn = document.getElementById('mobile-jump-btn');
        if (jumpBtn) {
            if (this.jumpClickHandler) jumpBtn.removeEventListener('click', this.jumpClickHandler);
            if (this.jumpTouchHandler) jumpBtn.removeEventListener('touchend', this.jumpTouchHandler);
        }
        this.jumpClickHandler = null;
        this.jumpTouchHandler = null;
        this.jumpHandler = null;

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
        this.characterController = null;
    }
}

export default new MobileJoystickManager();
