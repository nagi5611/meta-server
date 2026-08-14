// addons/qr-ar/test/center-qr-axes.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    qrCenterFromLocation,
    estimateCenterQrAxesPose,
    projectCenterQrAxes,
} from '../client/ar/center-qr-axes.js';

describe('qrCenterFromLocation', () => {
    it('returns geometric center of quad', () => {
        const center = qrCenterFromLocation({
            topLeftCorner: { x: 100, y: 100 },
            topRightCorner: { x: 200, y: 100 },
            bottomRightCorner: { x: 200, y: 200 },
            bottomLeftCorner: { x: 100, y: 200 },
        });
        assert.ok(center);
        assert.equal(center.x, 150);
        assert.equal(center.y, 150);
    });
});

describe('estimateCenterQrAxesPose', () => {
    it('projects axes from center for upright QR', () => {
        const location = {
            topLeftCorner: { x: 100, y: 100 },
            topRightCorner: { x: 200, y: 100 },
            bottomRightCorner: { x: 200, y: 200 },
            bottomLeftCorner: { x: 100, y: 200 },
        };
        const pose = estimateCenterQrAxesPose(location, 640, 480, 0.05);
        assert.ok(pose);
        const projected = projectCenterQrAxes(pose, 0.025);
        assert.equal(projected.length, 4);
        assert.ok(projected[0]);
        const ox = projected[0].x;
        const oy = projected[0].y;
        assert.ok(Math.abs(ox - 150) < 3);
        assert.ok(Math.abs(oy - 150) < 3);
    });
});
