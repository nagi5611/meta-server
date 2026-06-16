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

    it('selectModelsInSphere picks prefab part via AABB when bounding sphere misses', async () => {
        const manifest = {
            displayName: 'LongPart',
            parts: [
                {
                    file: 'models/long-part.glb',
                    bounds: {
                        center: [10, 0, 0],
                        radius: 1,
                        min: [0, -1, -1],
                        max: [20, 1, 1],
                    },
                },
                {
                    file: 'models/far-part.glb',
                    bounds: {
                        center: [80, 0, 0],
                        radius: 1,
                        min: [70, -1, -1],
                        max: [90, 1, 1],
                    },
                },
            ],
        };
        const models = [
            {
                prefabManifest: 'models/Long-prefab-manifest.json',
                position: { x: 30, y: 0, z: 0 },
                rotation: { x: 0, y: 0, z: 0 },
                scale: { x: 1, y: 1, z: 1 },
            },
        ];
        const entries = await selectModelsInSphere({
            worldModels: models,
            center: { x: 0, y: 0, z: 0 },
            radius: 35,
            loadManifest: async () => manifest,
        });
        assert.equal(entries.length, 1);
        assert.equal(entries[0].entryKind, 'prefab_parts');
        assert.deepEqual(entries[0].partIndices, [0]);
    });

    it('selectModelsInSphere respects prefab rotation (Three.js XYZ)', async () => {
        const manifest = {
            displayName: 'RotatedPart',
            parts: [
                {
                    file: 'models/near.glb',
                    bounds: {
                        center: [8, 0, 0],
                        radius: 2,
                        min: [6, -1, -1],
                        max: [10, 1, 1],
                    },
                },
            ],
        };
        const models = [
            {
                prefabManifest: 'models/Rot-prefab-manifest.json',
                position: { x: 0, y: 0, z: 0 },
                rotation: { x: 0, y: 90, z: 0 },
                scale: { x: 1, y: 1, z: 1 },
            },
        ];
        const entries = await selectModelsInSphere({
            worldModels: models,
            center: { x: 0, y: 0, z: 0 },
            radius: 10,
            loadManifest: async () => manifest,
        });
        assert.equal(entries.length, 1);
        assert.equal(entries[0].entryKind, 'prefab_parts');
        assert.deepEqual(entries[0].partIndices, [0]);
    });
});
