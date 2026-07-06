import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseMountsEnv, buildSnapshotDir, isPathUnderMount } from '../lib/mounts.js';

describe('mounts', () => {
    it('parseMountsEnv splits id:path pairs', () => {
        const parsed = parseMountsEnv('hdd-01:/mnt/a,hdd-02:/mnt/b');
        assert.equal(parsed.length, 2);
        assert.equal(parsed[0].id, 'hdd-01');
        assert.ok(parsed[0].path.endsWith('/mnt/a') || parsed[0].path.includes('mnt\\a'));
    });

    it('buildSnapshotDir nests under metaverse-simple', () => {
        const dir = buildSnapshotDir('/mnt/hdd', 'host1', 'hourly', '2026-07-06T12-00-00');
        assert.ok(dir.includes('metaverse-simple'));
        assert.ok(dir.includes('hourly'));
        assert.ok(dir.endsWith('2026-07-06T12-00-00'));
    });

    it('isPathUnderMount rejects traversal', () => {
        assert.equal(isPathUnderMount('/mnt/hdd/metaverse-simple/x', '/mnt/hdd'), true);
        assert.equal(isPathUnderMount('/other/x', '/mnt/hdd'), false);
    });
});
