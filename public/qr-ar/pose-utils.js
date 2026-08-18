// public/qr-ar/pose-utils.js — SDK カメラ・モデル姿勢の共通適用
import { Quaternion } from 'three';

/**
 * SDK から渡されたカメラ行列を Three.js カメラへ反映する。
 * @param {import('three').PerspectiveCamera} camera
 * @param {object} data
 */
export function applySdkCamera(camera, data) {
    if (data.projectionMatrix && data.projectionMatrix.length === 16) {
        camera.projectionMatrix.fromArray(data.projectionMatrix);
        camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
        return;
    }

    const params = data.cameraParams;
    if (!params) return;

    const { fx, fy, cx, cy, width, height } = params;
    if (!(fx > 0 && fy > 0 && width > 0 && height > 0)) return;

    const near = camera.near;
    const far = camera.far;
    const left = (-cx * near) / fx;
    const right = ((width - cx) * near) / fx;
    const top = (cy * near) / fy;
    const bottom = (-(height - cy) * near) / fy;

    camera.projectionMatrix.makePerspective(left, right, top, bottom, near, far);
    camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
}

/**
 * 検出データからモデルの位置・向きを更新する。
 * @param {import('three').Object3D} model
 * @param {object} data
 */
export function applyPoseToModel(model, data) {
    model.position.set(
        data.positionVector.x,
        data.positionVector.y,
        data.positionVector.z,
    );
    model.rotation.setFromQuaternion(
        new Quaternion(
            data.rotationQuaternion.x,
            data.rotationQuaternion.y,
            data.rotationQuaternion.z,
            data.rotationQuaternion.w,
        ),
    );
}
