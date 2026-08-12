// addons/qr-ar/test/pose-from-qr.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    estimatePoseFromQrCorners,
    applyOffsetInQrLocalSpace,
    smoothQrPose,
    qrLocationToImagePoints,
} from '../client/ar/pose-from-qr.js';
import {
    buildCameraIntrinsics,
    qrObjectPointsFromPhysicalSize,
    solvePnPPlanar,
    opencvPoseToThree,
} from '../client/ar/pnp-planar.js';

describe('estimatePoseFromQrCorners', () => {
    it('returns 6DoF pose for axis-aligned QR in center', () => {
        const location = {
            topLeftCorner: { x: 100, y: 100 },
            topRightCorner: { x: 200, y: 100 },
            bottomRightCorner: { x: 200, y: 200 },
            bottomLeftCorner: { x: 100, y: 200 },
        };
        const pose = estimatePoseFromQrCorners(location, 640, 480, 0.02, 60);
        assert.ok(pose);
        assert.equal(pose.cx, 150);
        assert.equal(pose.cy, 150);
        assert.equal(pose.width, 100);
        assert.ok(pose.distance > 0);
        assert.ok(pose.quaternion);
        assert.ok(Math.abs(pose.quaternion.w) > 0.9);
        assert.ok(pose.reprojectionError < 5);
        assert.ok(pose.position.z < 0);
    });

    it('returns null for tiny width', () => {
        const location = {
            topLeftCorner: { x: 100, y: 100 },
            topRightCorner: { x: 101, y: 100 },
            bottomRightCorner: { x: 101, y: 101 },
            bottomLeftCorner: { x: 100, y: 101 },
        };
        const pose = estimatePoseFromQrCorners(location, 640, 480, 0.02, 60);
        assert.equal(pose, null);
    });
});

describe('solvePnPPlanar round-trip', () => {
    it('recovers pose from projected corners', () => {
        const intrinsics = buildCameraIntrinsics(640, 480, 60);
        const size = 0.05;
        const objectPoints = qrObjectPointsFromPhysicalSize(size);
        const t = { x: 0.02, y: -0.01, z: 0.4 };
        const r = [1, 0, 0, 0, -1, 0, 0, 0, -1];

        const imagePoints = objectPoints.map((p) => {
            const cam = {
                x: r[0] * p.x + r[3] * p.y + r[6] * p.z + t.x,
                y: r[1] * p.x + r[4] * p.y + r[7] * p.z + t.y,
                z: r[2] * p.x + r[5] * p.y + r[8] * p.z + t.z,
            };
            return {
                x: (intrinsics.fx * cam.x) / cam.z + intrinsics.cx,
                y: (intrinsics.fy * cam.y) / cam.z + intrinsics.cy,
            };
        });

        const solved = solvePnPPlanar(objectPoints, imagePoints, intrinsics, size);
        assert.ok(solved);
        assert.ok(solved.reprojectionError < 2);
        assert.ok(Math.abs(solved.t.x - t.x) < 0.02);
        assert.ok(Math.abs(solved.t.y - t.y) < 0.02);
        assert.ok(Math.abs(solved.t.z - t.z) < 0.05);
    });
});

describe('applyOffsetInQrLocalSpace', () => {
    it('rotates offset by quaternion', () => {
        const q = { x: 0, y: 0, z: Math.sin(Math.PI / 4), w: Math.cos(Math.PI / 4) };
        const o = applyOffsetInQrLocalSpace({ x: 1, y: 0, z: 0 }, q);
        assert.ok(Math.abs(o.x) < 1e-10);
        assert.ok(Math.abs(o.y - 1) < 1e-10);
    });
});

describe('smoothQrPose', () => {
    it('lerps position and quaternion', () => {
        const a = {
            cx: 0,
            cy: 0,
            width: 100,
            distance: 1,
            position: { x: 0, y: 0, z: -1 },
            quaternion: { x: 0, y: 0, z: 0, w: 1 },
            reprojectionError: 1,
            focalLength: 500,
        };
        const b = {
            cx: 10,
            cy: 10,
            width: 110,
            distance: 2,
            position: { x: 0.1, y: 0.1, z: -2 },
            quaternion: { x: 0, y: 0, z: 0.1, w: 0.995 },
            reprojectionError: 2,
            focalLength: 500,
        };
        const s = smoothQrPose(a, b, 0.5);
        assert.ok(s);
        assert.equal(s.cx, 5);
        assert.equal(s.cy, 5);
        assert.equal(s.width, 105);
        assert.ok(s.quaternion);
    });
});

describe('qrLocationToImagePoints', () => {
    it('orders corners TL TR BR BL', () => {
        const loc = {
            topLeftCorner: { x: 1, y: 2 },
            topRightCorner: { x: 3, y: 4 },
            bottomRightCorner: { x: 5, y: 6 },
            bottomLeftCorner: { x: 7, y: 8 },
        };
        const pts = qrLocationToImagePoints(loc);
        assert.deepEqual(pts, [
            { x: 1, y: 2 },
            { x: 3, y: 4 },
            { x: 5, y: 6 },
            { x: 7, y: 8 },
        ]);
    });
});
