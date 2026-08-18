// public/qr-ar/pose-controller.js — 追跡状態管理とポーズ適用
import { applySdkCamera, applyPoseToModel } from './pose-utils.js';

export const TRIGGER_ID_QR = 1;
export const TRIGGER_ID_IMAGE = 2;

const TRIGGER_PRIORITY = {
    [TRIGGER_ID_IMAGE]: 2,
    [TRIGGER_ID_QR]: 1,
};

/**
 * 複数トリガーのポーズデータから優先度の高いものを選ぶ。
 * @param {object[]} dataList
 * @returns {object|null}
 */
export function selectPreferredPose(dataList) {
    if (!dataList?.length) return null;

    let best = null;
    let bestPriority = -1;

    for (const data of dataList) {
        const priority = TRIGGER_PRIORITY[data.triggerId] ?? 0;
        if (priority > bestPriority) {
            best = data;
            bestPriority = priority;
        }
    }

    return best;
}

/**
 * SDK イベントに応じてモデル姿勢と追跡状態を管理する。
 */
export class PoseController {
    /**
     * @param {{
     *   camera: import('three').PerspectiveCamera,
     *   model: import('three').Object3D,
     *   imuCompensator: import('./imu-compensator.js').ImuCompensator,
     *   onStatusChange?: (message: string) => void,
     * }} opts
     */
    constructor(opts) {
        this.camera = opts.camera;
        this.model = opts.model;
        this.imuCompensator = opts.imuCompensator;
        this.onStatusChange = opts.onStatusChange ?? (() => {});

        /** @type {'searching' | 'tracking' | 'imu_hold'} */
        this.state = 'searching';
        this.isAnchored = false;
    }

    /**
     * 現在の追跡状態を返す。
     */
    getState() {
        return this.state;
    }

    /**
     * @param {string} message
     */
    setStatus(message) {
        this.onStatusChange(message);
    }

    /**
     * SDK ポーズをモデルへ適用し追跡状態に遷移する。
     * @param {object} data
     */
    applyTrackingPose(data) {
        applySdkCamera(this.camera, data);
        if (!this.model) return;

        this.model.visible = true;
        applyPoseToModel(this.model, data);
        this.isAnchored = true;
        this.state = 'tracking';
        this.imuCompensator.reset();
        this.setStatus('マーカー追跡中');
    }

    /**
     * @param {object[]} detectedData
     */
    onDetected(detectedData) {
        const data = selectPreferredPose(detectedData);
        if (data) {
            this.applyTrackingPose(data);
        }
    }

    /**
     * @param {object[]} poseData
     */
    onPose(poseData) {
        const data = selectPreferredPose(poseData);
        if (data) {
            this.applyTrackingPose(data);
        }
    }

    /**
     * @param {object[]} lostData
     */
    onLost(lostData) {
        if (!this.isAnchored || !this.model) return;

        const data = selectPreferredPose(lostData) ?? lostData[0];
        if (data) {
            applySdkCamera(this.camera, data);
            applyPoseToModel(this.model, data);
        }

        this.model.visible = true;
        this.imuCompensator.captureReference(this.model);
        this.state = 'imu_hold';

        if (this.imuCompensator.isAvailable()) {
            this.setStatus('位置を維持中（IMU補正）');
        } else {
            this.setStatus('位置を維持中（固定表示）');
        }
    }

    /**
     * hold 中の毎フレーム更新。
     */
    onFrame() {
        if (this.state !== 'imu_hold' || !this.model) return;
        this.imuCompensator.update(this.model);
    }
}
