// public/qr-ar/imu-compensator.js — マーカー喪失後の IMU（デバイス姿勢）補正
import { Quaternion, Vector3, Euler } from 'three';

/**
 * DeviceOrientationEvent からクォータニオンを生成する。
 * @param {DeviceOrientationEvent} event
 * @returns {Quaternion|null}
 */
export function orientationEventToQuaternion(event) {
    if (event.alpha == null || event.beta == null || event.gamma == null) {
        return null;
    }

    const z = (event.alpha * Math.PI) / 180;
    const x = (event.beta * Math.PI) / 180;
    const y = (event.gamma * Math.PI) / 180;

    const euler = new Euler(x, y, -z, 'YXZ');
    return new Quaternion().setFromEuler(euler);
}

/**
 * iOS Safari 向けにデバイス姿勢の許可をリクエストする。
 * @returns {Promise<boolean>}
 */
export async function requestDeviceOrientationPermission() {
    const OrientationEvent = window.DeviceOrientationEvent;
    if (
        OrientationEvent &&
        typeof OrientationEvent.requestPermission === 'function'
    ) {
        try {
            const result = await OrientationEvent.requestPermission();
            return result === 'granted';
        } catch {
            return false;
        }
    }
    return true;
}

/**
 * マーカー喪失後にデバイス回転の変化分だけモデル姿勢を補正する。
 */
export class ImuCompensator {
    constructor() {
        this.active = false;
        this.hasOrientation = false;
        this.referenceQuat = new Quaternion();
        this.currentQuat = new Quaternion();
        this.frozenPosition = new Vector3();
        this.frozenRotation = new Quaternion();
        this._tempQuat = new Quaternion();
        this._invDelta = new Quaternion();
        this._refInverse = new Quaternion();
        this._tempVec = new Vector3();
    }

    /**
     * SDK のデバイス姿勢イベントを取り込む。
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
        this.frozenPosition.copy(model.position);
        this.frozenRotation.copy(model.quaternion);

        if (this.hasOrientation) {
            this.referenceQuat.copy(this.currentQuat);
            this.active = true;
            return;
        }

        this.active = false;
    }

    /**
     * IMU 補正を有効化する。
     */
    activate() {
        if (this.hasOrientation) {
            this.active = true;
        }
    }

    /**
     * 追跡復帰時に IMU 補正をリセットする。
     */
    reset() {
        this.active = false;
    }

    /**
     * hold 中に毎フレームモデルへ補正姿勢を適用する。
     * @param {import('three').Object3D} model
     * @returns {boolean} 補正を適用したか
     */
    update(model) {
        if (!this.active || !this.hasOrientation || !model) {
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
}
