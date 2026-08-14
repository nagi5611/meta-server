// addons/qr-ar/test/qr-corner-order.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    reconstructFourthCorner,
    orderQuadCornersTLTRBRBL,
    normalizeQrLocation,
} from '../client/ar/qr-corner-order.js';

describe('reconstructFourthCorner', () => {
    it('completes rectangle from three corners', () => {
        const tl = { x: 0, y: 0 };
        const tr = { x: 100, y: 0 };
        const bl = { x: 0, y: 100 };
        const br = reconstructFourthCorner(tl, tr, bl);
        assert.equal(br.x, 100);
        assert.equal(br.y, 100);
    });
});

describe('orderQuadCornersTLTRBRBL', () => {
    it('orders axis-aligned square', () => {
        const loc = orderQuadCornersTLTRBRBL([
            { x: 100, y: 100 },
            { x: 200, y: 100 },
            { x: 200, y: 200 },
            { x: 100, y: 200 },
        ]);
        assert.ok(loc);
        assert.equal(loc.topLeftCorner.x, 100);
        assert.equal(loc.topLeftCorner.y, 100);
        assert.equal(loc.bottomRightCorner.x, 200);
        assert.equal(loc.bottomRightCorner.y, 200);
    });

    it('orders rotated square from three points', () => {
        const tl = { x: 150, y: 120 };
        const tr = { x: 220, y: 90 };
        const bl = { x: 120, y: 190 };
        const loc = orderQuadCornersTLTRBRBL([tl, tr, bl]);
        assert.ok(loc);
        const br = reconstructFourthCorner(tl, tr, bl);
        assert.ok(Math.abs(loc.bottomRightCorner.x - br.x) < 1);
        assert.ok(Math.abs(loc.bottomRightCorner.y - br.y) < 1);
    });

    it('reorders scrambled detector output', () => {
        const loc = normalizeQrLocation({
            topLeftCorner: { x: 200, y: 200 },
            topRightCorner: { x: 100, y: 200 },
            bottomRightCorner: { x: 100, y: 100 },
            bottomLeftCorner: { x: 200, y: 100 },
        });
        assert.ok(loc);
        assert.equal(loc.topLeftCorner.x, 100);
        assert.equal(loc.topLeftCorner.y, 100);
        assert.equal(loc.bottomRightCorner.x, 200);
        assert.equal(loc.bottomRightCorner.y, 200);
    });
});
