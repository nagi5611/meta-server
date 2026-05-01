// tests/model-manifest.spec.mjs — lib/model-manifest.js とモデルファイル名ヘルパのユニット

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    basenameWithoutUploadVersionToken,
    basenameWithoutContentHashInjection,
    deriveDefaultLogicalModelsPath,
    buildModelManifestCatalog,
    readModelManifest,
    writeModelManifest,
} from '../lib/model-manifest.js';
import { insertContentHashStemBeforeExt } from '../lib/model-upload-version.js';

describe('model-manifest helpers', () => {
    it('strips _v_ upload token from basename', () => {
        assert.equal(
            basenameWithoutUploadVersionToken('foo_v_abc12_def34.glb'),
            'foo.glb',
        );
        assert.equal(basenameWithoutUploadVersionToken('plain.glb'), 'plain.glb');
    });

    it('strips content-hash stem before ext', () => {
        assert.equal(basenameWithoutContentHashInjection('Lobby.abcdabcdabcdabcd.gltf'), null);
        assert.equal(basenameWithoutContentHashInjection('Lobby.abcdabcdabcdabcd.glb'), 'Lobby.glb');
    });

    it('deriveDefaultLogical respects version and hash stripping', () => {
        assert.equal(deriveDefaultLogicalModelsPath('a_v_xx_y.glb'), 'models/a.glb');
        assert.equal(
            deriveDefaultLogicalModelsPath('sub/x.ffffffffffffffff.glb'),
            'models/sub/x.glb',
        );
    });
});

describe('insertContentHashStemBeforeExt', () => {
    it('embeds hash before extension', () => {
        assert.equal(insertContentHashStemBeforeExt('h.glb', 'deadbeef'), 'h.deadbeef.glb');
    });
});

describe('manifest catalog merge', () => {
    it('reads empty manifest and scans temporary glb on disk', async () => {
        const fs = await import('node:fs');
        const path = await import('node:path');
        const slug = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
        const dir = path.join(process.cwd(), 'tests', `.tmp_model_manifest_${slug}`);
        fs.mkdirSync(dir, { recursive: true });
        const glbRel = `discovered_${slug}.glb`;
        fs.writeFileSync(path.join(dir, glbRel), Buffer.from([0]));
        try {
            const { items } = buildModelManifestCatalog(dir);
            const found = items.find((x) => x.resolvedPath === `models/${glbRel}`);
            assert.ok(found);
            assert.ok(found.logicalPath.startsWith('models/'));
            const snapEmpty = readModelManifest(dir);
            writeModelManifest(dir, snapEmpty);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});
