import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeManifest, readManifest } from '../lib/snapshot-meta.js';

describe('snapshot-meta', () => {
    it('writeManifest and readManifest roundtrip', () => {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-meta-'));
        const manifest = {
            v: 1,
            snapshotId: '2026-07-06T10-00-00',
            kind: 'hourly',
            scope: 'state',
            mountId: 'hdd-01',
            hostname: 'test',
            createdAt: new Date().toISOString(),
            bytes: 123,
        };
        writeManifest(tmp, manifest);
        const read = readManifest(tmp);
        assert.equal(read?.snapshotId, manifest.snapshotId);
        assert.equal(read?.bytes, 123);
        fs.rmSync(tmp, { recursive: true, force: true });
    });
});
