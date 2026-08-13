// addons/qr-ar/test/temugeb-pose.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    temugebQrObjectPoints,
    temugebAxisObjectPoints,
    jsQrLocationToTemugebImagePoints,
    estimateTemugebQrPose,
    projectTemugebAxes,
} from '../client/ar/temugeb-pose.js';

describe('temugebQrObjectPoints', () => {
    it('matches run_qr.py qr_edges order', () => {
        const pts = temugebQrObjectPoints(1);
        assert.deepEqual(pts, [
            { x: 0, y: 0, z: 0 },
            { x: 0, y: 1, z: 0 },
            { x: 1, y: 1, z: 0 },
            { x: 1, y: 0, z: 0 },
        ]);
    });
});

describe('estimateTemugebQrPose', () => {
    it('returns pose and projects axes for upright QR', () => {
        const location = {
            topLeftCorner: { x: 100, y: 100 },
            topRightCorner: { x: 200, y: 100 },
            bottomRightCorner: { x: 200, y: 200 },
            bottomLeftCorner: { x: 100, y: 200 },
        };
        const imagePoints = jsQrLocationToTemugebImagePoints(location);
        assert.equal(imagePoints[0].x, 100);
        assert.equal(imagePoints[1].y, 200);
        assert.equal(imagePoints[3].x, 200);

        const pose = estimateTemugebQrPose(location, 640, 480, 0.05);
        assert.ok(pose);
        assert.ok(pose.reprojectionError < 5);

        const projected = projectTemugebAxes(pose, 0.05);
        assert.equal(projected.length, 4);
        assert.ok(projected[0]);
        assert.ok(projected[1]);
        assert.ok(projected[2]);
        assert.ok(projected[3]);
    });
});

describe('temugebAxisObjectPoints', () => {
    it('returns origin and unit axes', () => {
        const pts = temugebAxisObjectPoints(2);
        assert.deepEqual(pts[1], { x: 2, y: 0, z: 0 });
        assert.deepEqual(pts[3], { x: 0, y: 0, z: 2 });
    });
});
