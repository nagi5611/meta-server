// addons/qr-ar/client/ar/pnp-planar.js — 平面4点 PnP（OpenCV solvePnP 相当、純 JS）
// 参考: temugeb QR orientation (solvePnP + XY 平面 z=0)
//       Philomath88/PnPQRCode (homography + 法線向き制約)
//       Nyohohoho/marker-based-AR (マーカー四隅の 3D 対応)

/**
 * @typedef {{ fx: number, fy: number, cx: number, cy: number }} CameraIntrinsics
 * @typedef {{ x: number, y: number, z: number }} Vec3
 * @typedef {{ x: number, y: number, z: number, w: number }} Quat
 */

/**
 * カメラ内部パラメータを FOV から推定する
 * @param {number} videoWidth
 * @param {number} videoHeight
 * @param {number} [fovDeg]
 * @returns {CameraIntrinsics}
 */
export function buildCameraIntrinsics(videoWidth, videoHeight, fovDeg = 60) {
    const fov = (fovDeg * Math.PI) / 180;
    const fy = videoHeight / (2 * Math.tan(fov / 2));
    const fx = fy;
    return {
        fx,
        fy,
        cx: videoWidth / 2,
        cy: videoHeight / 2,
    };
}

/**
 * jsQR 四隅を QR ローカル座標（XY 平面、Z は面から垂直）へ対応付ける
 * 原点: QR 中心、X: 右、Y: 上、Z: 面からカメラ方向（右手系）
 * @param {number} physicalSizeM QR の物理幅（メートル）
 * @returns {Vec3[]}
 */
export function qrObjectPointsFromPhysicalSize(physicalSizeM) {
    const h = physicalSizeM / 2;
    return [
        { x: -h, y: h, z: 0 }, // topLeft
        { x: h, y: h, z: 0 }, // topRight
        { x: h, y: -h, z: 0 }, // bottomRight
        { x: -h, y: -h, z: 0 }, // bottomLeft
    ];
}

/**
 * @param {Vec3} a
 * @param {Vec3} b
 */
function sub3(a, b) {
    return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

/**
 * @param {Vec3} a
 */
function len3(a) {
    return Math.hypot(a.x, a.y, a.z);
}

/**
 * @param {Vec3} a
 */
function norm3(a) {
    const l = len3(a);
    if (l < 1e-12) return { x: 0, y: 0, z: 0 };
    return { x: a.x / l, y: a.y / l, z: a.z / l };
}

/**
 * @param {Vec3} a
 * @param {Vec3} b
 */
function cross3(a, b) {
    return {
        x: a.y * b.z - a.z * b.y,
        y: a.z * b.x - a.x * b.z,
        z: a.x * b.y - a.y * b.x,
    };
}

/**
 * @param {Vec3} a
 * @param {Vec3} b
 */
function dot3(a, b) {
    return a.x * b.x + a.y * b.y + a.z * b.z;
}

/**
 * 3x3 回転行列（列ベクトルが物体座標軸をカメラ座標で表現、OpenCV 系）をクォータニオンへ
 * @param {number[]} m 9 要素、列優先
 * @returns {Quat}
 */
export function rotationMatrixToQuaternion(m) {
    const m00 = m[0];
    const m01 = m[3];
    const m02 = m[6];
    const m10 = m[1];
    const m11 = m[4];
    const m12 = m[7];
    const m20 = m[2];
    const m21 = m[5];
    const m22 = m[8];

    const trace = m00 + m11 + m22;
    let x;
    let y;
    let z;
    let w;

    if (trace > 0) {
        const s = Math.sqrt(trace + 1) * 2;
        w = 0.25 * s;
        x = (m21 - m12) / s;
        y = (m02 - m20) / s;
        z = (m10 - m01) / s;
    } else if (m00 > m11 && m00 > m22) {
        const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
        w = (m21 - m12) / s;
        x = 0.25 * s;
        y = (m01 + m10) / s;
        z = (m02 + m20) / s;
    } else if (m11 > m22) {
        const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
        w = (m02 - m20) / s;
        x = (m01 + m10) / s;
        y = 0.25 * s;
        z = (m12 + m21) / s;
    } else {
        const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
        w = (m10 - m01) / s;
        x = (m02 + m20) / s;
        y = (m12 + m21) / s;
        z = 0.25 * s;
    }

    const n = Math.hypot(x, y, z, w);
    if (n < 1e-12) return { x: 0, y: 0, z: 0, w: 1 };
    return { x: x / n, y: y / n, z: z / n, w: w / n };
}

/**
 * OpenCV カメラ座標（X右 Y下 Z奥）を Three.js（X右 Y上 Z手前=-奥）へ
 * @param {Vec3} t
 * @param {number[]} r 9 要素列優先
 * @returns {{ position: Vec3, quaternion: Quat, rotationMatrix: number[] }}
 */
export function opencvPoseToThree(t, r) {
    const position = { x: t.x, y: -t.y, z: -t.z };
    const rotationMatrix = [
        r[0], -r[1], -r[2],
        r[3], -r[4], -r[5],
        r[6], -r[7], -r[8],
    ];
    const quaternion = rotationMatrixToQuaternion(rotationMatrix);
    return { position, quaternion, rotationMatrix };
}

/**
 * @param {Vec3} p
 * @param {number[]} r
 * @param {Vec3} t
 */
function transformPoint(p, r, t) {
    return {
        x: r[0] * p.x + r[3] * p.y + r[6] * p.z + t.x,
        y: r[1] * p.x + r[4] * p.y + r[7] * p.z + t.y,
        z: r[2] * p.x + r[5] * p.y + r[8] * p.z + t.z,
    };
}

/**
 * @param {Vec3} pCam
 * @param {CameraIntrinsics} k
 */
function projectPoint(pCam, k) {
    if (pCam.z <= 1e-6) return null;
    return {
        x: (k.fx * pCam.x) / pCam.z + k.cx,
        y: (k.fy * pCam.y) / pCam.z + k.cy,
    };
}

/**
 * @param {Vec3[]} objectPoints
 * @param {{x:number,y:number}[]} imagePoints
 * @param {number[]} r
 * @param {Vec3} t
 * @param {CameraIntrinsics} k
 */
function reprojectionError(objectPoints, imagePoints, r, t, k) {
    let err = 0;
    for (let i = 0; i < objectPoints.length; i++) {
        const cam = transformPoint(objectPoints[i], r, t);
        const proj = projectPoint(cam, k);
        if (!proj) return Number.POSITIVE_INFINITY;
        err += Math.hypot(proj.x - imagePoints[i].x, proj.y - imagePoints[i].y);
    }
    return err / objectPoints.length;
}

/**
 * 物体原点から +X / +Y 方向の画像点を選ぶ
 * @param {Vec3[]} objectPoints
 * @param {{x:number,y:number}[]} imagePoints
 */
function pickAxisImageCorners(objectPoints, imagePoints) {
    let xIdx = 1;
    let yIdx = 1;
    let maxX = -Infinity;
    let maxY = -Infinity;

    for (let i = 1; i < 4; i++) {
        const ox = objectPoints[i].x - objectPoints[0].x;
        const oy = objectPoints[i].y - objectPoints[0].y;
        if (ox > maxX) {
            maxX = ox;
            xIdx = i;
        } else if (ox > 1e-9 && Math.abs(ox - maxX) < 1e-9) {
            const dy = Math.abs(imagePoints[i].y - imagePoints[0].y);
            const prevDy = Math.abs(imagePoints[xIdx].y - imagePoints[0].y);
            if (dy < prevDy) xIdx = i;
        }
        if (oy > maxY) {
            maxY = oy;
            yIdx = i;
        } else if (oy > 1e-9 && Math.abs(oy - maxY) < 1e-9) {
            const dx = Math.abs(imagePoints[i].x - imagePoints[0].x);
            const prevDx = Math.abs(imagePoints[yIdx].x - imagePoints[0].x);
            if (dx < prevDx) yIdx = i;
        }
    }

    return {
        origin: imagePoints[0],
        xCorner: imagePoints[xIdx],
        yCorner: imagePoints[yIdx],
    };
}

/**
 * 物体原点からの辺長（ピクセル）の最大値
 * @param {Vec3[]} objectPoints
 * @param {{x:number,y:number}[]} imagePoints
 */
function estimateOriginEdgeWidthPx(objectPoints, imagePoints) {
    let best = 0;
    for (let i = 1; i < 4; i++) {
        const objLen = Math.hypot(
            objectPoints[i].x - objectPoints[0].x,
            objectPoints[i].y - objectPoints[0].y,
            objectPoints[i].z - objectPoints[0].z
        );
        if (objLen < 1e-9) continue;
        const imgLen = Math.hypot(
            imagePoints[i].x - imagePoints[0].x,
            imagePoints[i].y - imagePoints[0].y
        );
        if (imgLen > best) best = imgLen;
    }
    return best < 4 ? 0 : best;
}

/**
 * TemugeB 形式（原点が corner #1 = (0,0,0)）かどうか
 * @param {Vec3[]} objectPoints
 */
function isCornerOriginObjectPoints(objectPoints) {
    const o = objectPoints[0];
    if (Math.abs(o.x) > 1e-6 || Math.abs(o.y) > 1e-6 || Math.abs(o.z) > 1e-6) return false;
    return objectPoints.some((p) => p.x > 1e-6) && objectPoints.some((p) => p.y > 1e-6);
}

/**
 * 初期姿勢（距離 + 辺ベクトルから回転を構成）
 * @param {Vec3[]} objectPoints
 * @param {{x:number,y:number}[]} imagePoints
 * @param {CameraIntrinsics} k
 * @param {number} physicalSizeM
 */
function estimateInitialPose(objectPoints, imagePoints, k, physicalSizeM) {
    const cornerOrigin = isCornerOriginObjectPoints(objectPoints);
    const corners = cornerOrigin
        ? pickAxisImageCorners(objectPoints, imagePoints)
        : {
              origin: imagePoints[0],
              xCorner: imagePoints[1],
              yCorner: imagePoints[3],
          };

    const tl = corners.origin;
    const tr = corners.xCorner;
    const bl = corners.yCorner;

    const cx = (imagePoints[0].x + imagePoints[1].x + imagePoints[2].x + imagePoints[3].x) / 4;
    const cy = (imagePoints[0].y + imagePoints[1].y + imagePoints[2].y + imagePoints[3].y) / 4;
    const widthPx = cornerOrigin
        ? estimateOriginEdgeWidthPx(objectPoints, imagePoints)
        : Math.hypot(tr.x - tl.x, tr.y - tl.y);
    if (widthPx < 4) return null;

    const tz = (k.fx * physicalSizeM) / widthPx;
    if (!Number.isFinite(tz) || tz <= 0) return null;

    const backproject = (px, py, depth) => ({
        x: ((px - k.cx) * depth) / k.fx,
        y: ((py - k.cy) * depth) / k.fy,
        z: depth,
    });

    const t = cornerOrigin
        ? backproject(tl.x, tl.y, tz)
        : {
              x: ((cx - k.cx) * tz) / k.fx,
              y: ((cy - k.cy) * tz) / k.fy,
              z: tz,
          };

    const camOrigin = backproject(tl.x, tl.y, tz);
    const camX = backproject(tr.x, tr.y, tz);
    const camY = backproject(bl.x, bl.y, tz);

    let rx = norm3(sub3(camX, camOrigin));
    let ry = norm3(sub3(camY, camOrigin));
    let rz = norm3(cross3(rx, ry));

    if (!cornerOrigin && dot3(rz, t) > 0) {
        rz = { x: -rz.x, y: -rz.y, z: -rz.z };
    }

    if (!cornerOrigin) {
        ry = norm3(cross3(rz, rx));
        rx = norm3(cross3(ry, rz));
    }

    const r = [rx.x, rx.y, rx.z, ry.x, ry.y, ry.z, rz.x, rz.y, rz.z];
    return { r, t };
}

/**
 * ロドリゲス: 軸角 → 回転行列（列優先 9 要素）
 * @param {Vec3} axisAngle
 */
function rodrigues(axisAngle) {
    const theta = len3(axisAngle);
    if (theta < 1e-12) {
        return [1, 0, 0, 0, 1, 0, 0, 0, 1];
    }
    const kx = axisAngle.x / theta;
    const ky = axisAngle.y / theta;
    const kz = axisAngle.z / theta;
    const c = Math.cos(theta);
    const s = Math.sin(theta);
    const v = 1 - c;
    return [
        kx * kx * v + c,
        kx * ky * v + kz * s,
        kx * kz * v - ky * s,
        ky * kx * v - kz * s,
        ky * ky * v + c,
        ky * kz * v + kx * s,
        kz * kx * v + ky * s,
        kz * ky * v - kx * s,
        kz * kz * v + c,
    ];
}

/**
 * 回転行列 × ベクトル
 * @param {number[]} r
 * @param {Vec3} v
 */
function mat3MulVec(r, v) {
    return {
        x: r[0] * v.x + r[3] * v.y + r[6] * v.z,
        y: r[1] * v.x + r[4] * v.y + r[7] * v.z,
        z: r[2] * v.x + r[5] * v.y + r[8] * v.z,
    };
}

/**
 * 回転行列の転置（正規直交）
 * @param {number[]} r
 */
function transposeMat3(r) {
    return [r[0], r[3], r[6], r[1], r[4], r[7], r[2], r[5], r[8]];
}

/**
 * @param {number[]} a
 * @param {number[]} b
 */
function mat3Mul(a, b) {
    return [
        a[0] * b[0] + a[3] * b[1] + a[6] * b[2],
        a[1] * b[0] + a[4] * b[1] + a[7] * b[2],
        a[2] * b[0] + a[5] * b[1] + a[8] * b[2],
        a[0] * b[3] + a[3] * b[4] + a[6] * b[5],
        a[1] * b[3] + a[4] * b[4] + a[7] * b[5],
        a[2] * b[3] + a[5] * b[4] + a[8] * b[5],
        a[0] * b[6] + a[3] * b[7] + a[6] * b[8],
        a[1] * b[6] + a[4] * b[7] + a[7] * b[8],
        a[2] * b[6] + a[5] * b[7] + a[8] * b[8],
    ];
}

/**
 * Gauss-Newton で再投影誤差を最小化
 * @param {Vec3[]} objectPoints
 * @param {{x:number,y:number}[]} imagePoints
 * @param {number[]} r
 * @param {Vec3} t
 * @param {CameraIntrinsics} k
 */
function refinePoseIterative(objectPoints, imagePoints, r, t, k, iterations = 12) {
    let curR = r.slice();
    let curT = { ...t };

    for (let iter = 0; iter < iterations; iter++) {
        const jacobian = [];
        const residuals = [];

        for (let i = 0; i < objectPoints.length; i++) {
            const cam = transformPoint(objectPoints[i], curR, curT);
            if (cam.z <= 1e-6) return { r: curR, t: curT };

            const u = (k.fx * cam.x) / cam.z + k.cx;
            const v = (k.fy * cam.y) / cam.z + k.cy;
            const du = u - imagePoints[i].x;
            const dv = v - imagePoints[i].y;
            residuals.push(du, dv);

            const z = cam.z;
            const z2 = z * z;
            const du_dx = k.fx / z;
            const du_dy = 0;
            const du_dz = -(k.fx * cam.x) / z2;
            const dv_dx = 0;
            const dv_dy = k.fy / z;
            const dv_dz = -(k.fy * cam.y) / z2;

            const p = objectPoints[i];
            const rcx = mat3MulVec(curR, p);
            const dr = transposeMat3(curR);
            const dCam_dr = [
                [dr[0] * p.x + dr[3] * p.y + dr[6] * p.z, dr[1] * p.x + dr[4] * p.y + dr[7] * p.z, dr[2] * p.x + dr[5] * p.y + dr[8] * p.z],
                [dr[0] * p.x + dr[3] * p.y + dr[6] * p.z, dr[1] * p.x + dr[4] * p.y + dr[7] * p.z, dr[2] * p.x + dr[5] * p.y + dr[8] * p.z],
                [dr[0] * p.x + dr[3] * p.y + dr[6] * p.z, dr[1] * p.x + dr[4] * p.y + dr[7] * p.z, dr[2] * p.x + dr[5] * p.y + dr[8] * p.z],
            ];

            const rowU = [];
            const rowV = [];
            for (let j = 0; j < 3; j++) {
                const dcx = dCam_dr[0][j];
                const dcy = dCam_dr[1][j];
                const dcz = dCam_dr[2][j];
                rowU.push(du_dx * dcx + du_dy * dcy + du_dz * dcz);
                rowV.push(dv_dx * dcx + dv_dy * dcy + dv_dz * dcz);
            }
            rowU.push(du_dx, du_dy, du_dz);
            rowV.push(dv_dx, dv_dy, dv_dz);
            jacobian.push(rowU, rowV);
        }

        const delta = solveNormalEquations(jacobian, residuals, 6);
        if (!delta) break;

        const axisAngle = { x: delta[0], y: delta[1], z: delta[2] };
        const dR = rodrigues(axisAngle);
        curR = mat3Mul(dR, curR);
        curT.x += delta[3];
        curT.y += delta[4];
        curT.z += delta[5];
    }

    return { r: curR, t: curT };
}

/**
 * 最小二乗 Jx = -r（6 変数）
 * @param {number[][]} jacobian
 * @param {number[]} residuals
 * @param {number} n
 */
function solveNormalEquations(jacobian, residuals, n) {
    const jtJ = Array.from({ length: n }, () => Array(n).fill(0));
    const jtR = Array(n).fill(0);

    for (let row = 0; row < jacobian.length; row++) {
        const jRow = jacobian[row];
        const r = residuals[row];
        for (let i = 0; i < n; i++) {
            jtR[i] -= jRow[i] * r;
            for (let j = 0; j < n; j++) {
                jtJ[i][j] += jRow[i] * jRow[j];
            }
        }
    }

    for (let i = 0; i < n; i++) {
        jtJ[i][i] += 1e-6;
    }

    return solveLinear6(jtJ, jtR);
}

/**
 * 6x6 線形方程式
 * @param {number[][]} a
 * @param {number[]} b
 */
function solveLinear6(a, b) {
    const m = a.map((row, i) => [...row, b[i]]);

    for (let col = 0; col < 6; col++) {
        let pivot = col;
        for (let row = col + 1; row < 6; row++) {
            if (Math.abs(m[row][col]) > Math.abs(m[pivot][col])) pivot = row;
        }
        if (Math.abs(m[pivot][col]) < 1e-12) return null;
        if (pivot !== col) {
            const tmp = m[col];
            m[col] = m[pivot];
            m[pivot] = tmp;
        }
        const div = m[col][col];
        for (let j = col; j <= 6; j++) m[col][j] /= div;
        for (let row = 0; row < 6; row++) {
            if (row === col) continue;
            const factor = m[row][col];
            if (Math.abs(factor) < 1e-12) continue;
            for (let j = col; j <= 6; j++) {
                m[row][j] -= factor * m[col][j];
            }
        }
    }

    return m.map((row) => row[6]);
}

/**
 * 平面ターゲットの PnP を解く（物体→OpenCV カメラ）
 * @param {Vec3[]} objectPoints
 * @param {{x:number,y:number}[]} imagePoints
 * @param {CameraIntrinsics} intrinsics
 * @param {number} physicalSizeM
 * @returns {{ r: number[], t: Vec3, reprojectionError: number } | null}
 */
export function solvePnPPlanar(objectPoints, imagePoints, intrinsics, physicalSizeM) {
    if (!objectPoints?.length || objectPoints.length !== 4 || imagePoints?.length !== 4) return null;

    const cornerOrigin = isCornerOriginObjectPoints(objectPoints);

    const initial = estimateInitialPose(objectPoints, imagePoints, intrinsics, physicalSizeM);
    if (!initial) return null;

    const initialErr = reprojectionError(objectPoints, imagePoints, initial.r, initial.t, intrinsics);
    if (initialErr < 0.5) {
        return { r: initial.r, t: initial.t, reprojectionError: initialErr };
    }

    let best = refinePoseIterative(objectPoints, imagePoints, initial.r, initial.t, intrinsics);
    let bestErr = reprojectionError(objectPoints, imagePoints, best.r, best.t, intrinsics);

    const nz0 = { x: best.r[6], y: best.r[7], z: best.r[8] };
    if (!cornerOrigin && dot3(nz0, best.t) > 0) {
        const flippedR = [
            -best.r[0], -best.r[1], -best.r[2],
            best.r[3], best.r[4], best.r[5],
            -best.r[6], -best.r[7], -best.r[8],
        ];
        const flipped = refinePoseIterative(objectPoints, imagePoints, flippedR, best.t, intrinsics);
        const flippedErr = reprojectionError(objectPoints, imagePoints, flipped.r, flipped.t, intrinsics);
        if (flippedErr <= bestErr + 0.5) {
            best = flipped;
            bestErr = flippedErr;
        }
    }

    if (!Number.isFinite(bestErr) || bestErr > 28) return null;

    return { r: best.r, t: best.t, reprojectionError: bestErr };
}

/**
 * 物体座標点を画像へ投影（OpenCV projectPoints 相当）
 * @param {Vec3[]} objectPoints
 * @param {number[]} r
 * @param {Vec3} t
 * @param {CameraIntrinsics} intrinsics
 * @returns {({x:number,y:number}|null)[]}
 */
export function projectObjectPoints(objectPoints, r, t, intrinsics) {
    return objectPoints.map((p) => {
        const cam = transformPoint(p, r, t);
        return projectPoint(cam, intrinsics);
    });
}
