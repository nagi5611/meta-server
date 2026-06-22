// addons/webxr-vr/test/vr-quick-menu-input.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { pollLeftYButtonEdge } from '../client/vr-quick-menu-input.js';

describe('pollLeftYButtonEdge', () => {
    it('returns edge on false→true transition', () => {
        const session = {
            inputSources: [{
                handedness: 'left',
                gamepad: { buttons: [{ pressed: false }, {}, {}, {}, {}, { pressed: true }] },
            }],
        };
        const r = pollLeftYButtonEdge(session, false);
        assert.equal(r.pressed, true);
        assert.equal(r.edge, true);
    });

    it('no edge when held', () => {
        const session = {
            inputSources: [{
                handedness: 'left',
                gamepad: { buttons: [{}, {}, {}, {}, {}, { pressed: true }] },
            }],
        };
        const r = pollLeftYButtonEdge(session, true);
        assert.equal(r.pressed, true);
        assert.equal(r.edge, false);
    });

    it('no press without left controller', () => {
        const session = {
            inputSources: [{
                handedness: 'right',
                gamepad: { buttons: [{}, {}, {}, {}, {}, { pressed: true }] },
            }],
        };
        const r = pollLeftYButtonEdge(session, false);
        assert.equal(r.pressed, false);
        assert.equal(r.edge, false);
    });
});
