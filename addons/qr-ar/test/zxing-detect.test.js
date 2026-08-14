// addons/qr-ar/test/zxing-detect.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { zxingResultPointsToLocation } from '../client/ar/zxing-location.js';

describe('zxingResultPointsToLocation', () => {
    it('reconstructs fourth corner from three ZXing points', () => {
        const points = [
            { getX: () => 10, getY: () => 110 },
            { getX: () => 10, getY: () => 10 },
            { getX: () => 110, getY: () => 10 },
        ];
        const loc = zxingResultPointsToLocation(points);
        assert.ok(loc);
        assert.equal(loc.topLeftCorner.x, 10);
        assert.equal(loc.topLeftCorner.y, 10);
        assert.equal(loc.bottomRightCorner.x, 110);
        assert.equal(loc.bottomRightCorner.y, 110);
    });
});
