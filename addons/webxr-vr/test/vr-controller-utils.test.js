// addons/webxr-vr/test/vr-controller-utils.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveRightControllerIndex } from '../client/vr-controller-utils.js';

describe('resolveRightControllerIndex', () => {
    it('returns index with handedness right', () => {
        const renderer = {
            xr: {
                getController: (i) => ({
                    inputSource: i === 1 ? { handedness: 'right' } : { handedness: 'left' },
                }),
            },
        };
        assert.equal(resolveRightControllerIndex(renderer), 1);
    });

    it('falls back to 0 when no right handedness', () => {
        const renderer = {
            xr: {
                getController: () => ({ inputSource: null }),
            },
        };
        assert.equal(resolveRightControllerIndex(renderer), 0);
    });
});
