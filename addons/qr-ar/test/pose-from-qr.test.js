// addons/qr-ar/test/pose-from-qr.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    estimatePoseFromQrCorners,
    applyOffsetInQrPlane,
    smoothQrPose,
} from '../client/ar/pose-from-qr.js';

describe('estimatePoseFromQrCorners', () => {
    it('returns pose for axis-aligned QR in center', () => {
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
        assert.ok(Math.abs(pose.angle) < 0.01);
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

describe('applyOffsetInQrPlane', () => {
    it('rotates offset by angle', () => {
        const o = applyOffsetInQrPlane({ x: 1, y: 0, z: 0 }, Math.PI / 2);
        assert.ok(Math.abs(o.x) < 1e-10);
        assert.ok(Math.abs(o.y - 1) < 1e-10);
    });
});

describe('smoothQrPose', () => {
    it('lerps between poses', () => {
        const a = {
            cx: 0,
            cy: 0,
            width: 100,
            distance: 1,
            angle: 0,
            position: { x: 0, y: 0, z: -1 },
            focalLength: 500,
        };
        const b = {
            cx: 10,
            cy: 10,
            width: 110,
            distance: 2,
            angle: 0.1,
            position: { x: 0.1, y: 0.1, z: -2 },
            focalLength: 500,
        };
        const s = smoothQrPose(a, b, 0.5);
        assert.ok(s);
        assert.equal(s.cx, 5);
        assert.equal(s.cy, 5);
        assert.equal(s.width, 105);
    });
});
