// addons/nfc-spawn/test/sphere-selection.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    aabbIntersectsSphere,
    spheresIntersect,
    selectModelsInSphere,
} from '../lib/sphere-selection.js';

describe('sphere-selection', () => {
    it('aabbIntersectsSphere detects overlap', () => {
        const center = { x: 0, y: 0, z: 0 };
        const min = { x: -2, y: -2, z: -2 };
        const max = { x: 2, y: 2, z: 2 };
        assert.equal(aabbIntersectsSphere(center, 5, min, max), true);
        assert.equal(aabbIntersectsSphere({ x: 10, y: 0, z: 0 }, 1, min, max), false);
    });

    it('spheresIntersect', () => {
        assert.equal(spheresIntersect({ x: 0, y: 0, z: 0 }, 2, { x: 3, y: 0, z: 0 }, 2), true);
        assert.equal(spheresIntersect({ x: 0, y: 0, z: 0 }, 1, { x: 5, y: 0, z: 0 }, 1), false);
    });

    it('selectModelsInSphere picks glb near center', async () => {
        const models = [
            {
                path: 'models/test.glb',
                position: { x: 2, y: 0, z: 0 },
                rotation: { x: 0, y: 0, z: 0 },
                scale: { x: 1, y: 1, z: 1 },
            },
            {
                path: 'models/far.glb',
                position: { x: 100, y: 0, z: 0 },
                rotation: { x: 0, y: 0, z: 0 },
                scale: { x: 1, y: 1, z: 1 },
            },
        ];
        const entries = await selectModelsInSphere({
            worldModels: models,
            center: { x: 0, y: 0, z: 0 },
            radius: 10,
            defaultModelRadius: 5,
            loadManifest: async () => null,
        });
        assert.equal(entries.length, 1);
        assert.equal(entries[0].entryKind, 'glb');
        assert.equal(entries[0].worldModelIndex, 0);
    });

    it('skips plane assets', async () => {
        const models = [
            { prefabManifest: 'plane/foo-prefab-manifest.json', position: { x: 0, y: 0, z: 0 } },
        ];
        const entries = await selectModelsInSphere({
            worldModels: models,
            center: { x: 0, y: 0, z: 0 },
            radius: 50,
            loadManifest: async () => ({}),
        });
        assert.equal(entries.length, 0);
    });
});
