// public/qr-ar/imu-compensator.js — マーカー喪失後の IMU（デバイス姿勢）補正
import { Quaternion, Vector3, Euler } from 'three';

/**
 * 画面回転角を取得する。
 * @returns {number}
 */
function getScreenOrientationAngle() {
    if (window.screen?.orientation?.angle != null) {
        return window.screen.orientation.angle;
    }
    return window.orientation ?? 0;
}

/**
 * DeviceOrientationEvent からクォータニオンを生成する。
 * @param {DeviceOrientationEvent} event
 * @returns {Quaternion|null}
 */
export function orientationEventToQuaternion(event) {
    if (event.alpha == null || event.beta == null || event.gamma == null) {
        return null;
    }

    const screenAngle = getScreenOrientationAngle();
    const alpha = ((event.alpha + screenAngle) * Math.PI) / 180;
    const beta = (event.beta * Math.PI) / 180;
    const gamma = (event.gamma * Math.PI) / 180;

    const euler = new Euler(beta, gamma, -alpha, 'YXZ');
    return new Quaternion().setFromEuler(euler);
}

/**
 * iOS Safari 向けにモーション・姿勢センサーの許可をリクエストする。
 * Android / PC ではダイアログは出ない（正常）。
 * @returns {Promise<boolean>} いずれかが許可された、または許可不要な環境なら true
 */
export async function requestMotionPermissions() {
    let orientationGranted = false;
    let motionGranted = false;
    let orientationRequired = false;
    let motionRequired = false;

    const OrientationEvent = window.DeviceOrientationEvent;
    if (OrientationEvent && typeof OrientationEvent.requestPermission === 'function') {
        orientationRequired = true;
        try {
            const result = await OrientationEvent.requestPermission();
            orientationGranted = result === 'granted';
        } catch {
            orientationGranted = false;
        }
    } else {
        orientationGranted = true;
    }

    const MotionEvent = window.DeviceMotionEvent;
    if (MotionEvent && typeof MotionEvent.requestPermission === 'function') {
        motionRequired = true;
        try {
            const result = await MotionEvent.requestPermission();
            motionGranted = result === 'granted';
        } catch {
            motionGranted = false;
        }
    } else {
        motionGranted = true;
    }

    if (!orientationRequired && !motionRequired) {
        return true;
    }

    return orientationGranted || motionGranted;
}

/**
 * @deprecated requestMotionPermissions を使用してください
 */
export async function requestDeviceOrientationPermission() {
    return requestMotionPermissions();
}

/**
 * マーカー喪失後にデバイス回転の変化分だけモデル姿勢を補正する。
 */
export class ImuCompensator {
    constructor() {
        this.active = false;
        this.hasOrientation = false;
        this.pendingCapture = false;
        this.modelRef = null;
        this.referenceQuat = new Quaternion();
        this.currentQuat = new Quaternion();
        this.frozenPosition = new Vector3();
        this.frozenRotation = new Quaternion();
        this._tempQuat = new Quaternion();
        this._invDelta = new Quaternion();
        this._refInverse = new Quaternion();
        this._tempVec = new Vector3();
        this._onOrientation = this.handleOrientationEvent.bind(this);
        this.listening = false;
    }

    /**
     * window の deviceorientation を直接購読する（SDK イベントに依存しない）。
     */
    startListening() {
        if (this.listening) return;
        window.addEventListener('deviceorientation', this._onOrientation, true);
        this.listening = true;
    }

    /**
     * リスナーを解除する。
     */
    stopListening() {
        if (!this.listening) return;
        window.removeEventListener('deviceorientation', this._onOrientation, true);
        this.listening = false;
    }

    /**
     * @param {DeviceOrientationEvent} event
     */
    handleOrientationEvent(event) {
        this.handleOrientation(event);
        if (this.pendingCapture && this.modelRef && this.hasOrientation) {
            this.captureReference(this.modelRef);
            this.pendingCapture = false;
        }
    }

    /**
     * SDK / window 双方から呼べる姿勢更新。
     * @param {DeviceOrientationEvent} event
     */
    handleOrientation(event) {
        const quat = orientationEventToQuaternion(event);
        if (!quat) return;
        this.currentQuat.copy(quat);
        this.hasOrientation = true;
    }

    /**
     * 喪失時のモデル姿勢とデバイス姿勢を基準として保存する。
     * @param {import('three').Object3D} model
     */
    captureReference(model) {
        this.modelRef = model;
        this.frozenPosition.copy(model.position);
        this.frozenRotation.copy(model.quaternion);

        if (this.hasOrientation) {
            this.referenceQuat.copy(this.currentQuat);
            this.active = true;
            this.pendingCapture = false;
            return;
        }

        this.active = false;
        this.pendingCapture = true;
    }

    /**
     * 追跡復帰時に IMU 補正をリセットする。
     */
    reset() {
        this.active = false;
        this.pendingCapture = false;
        this.modelRef = null;
    }

    /**
     * hold 中に毎フレームモデルへ補正姿勢を適用する。
     * @param {import('three').Object3D} model
     * @returns {boolean}
     */
    update(model) {
        if ((!this.active && !this.pendingCapture) || !model) {
            return false;
        }

        if (this.pendingCapture && this.hasOrientation) {
            this.captureReference(model);
        }

        if (!this.active || !this.hasOrientation) {
            return false;
        }

        const deltaQuat = this._tempQuat
            .copy(this.currentQuat)
            .multiply(this._refInverse.copy(this.referenceQuat).invert());

        const invDelta = this._invDelta.copy(deltaQuat).invert();

        this._tempVec.copy(this.frozenPosition).applyQuaternion(invDelta);
        model.position.copy(this._tempVec);

        model.quaternion.copy(invDelta).multiply(this.frozenRotation);
        return true;
    }

    /**
     * IMU データが利用可能か。
     */
    isAvailable() {
        return this.hasOrientation;
    }

    /**
     * IMU 補正が動作中か。
     */
    isActive() {
        return this.active;
    }
}
