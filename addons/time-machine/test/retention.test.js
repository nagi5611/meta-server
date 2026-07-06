import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listSnapshotDirs } from '../lib/snapshot-meta.js';
import { pruneSnapshots } from '../lib/retention.js';

describe('retention', () => {
    it('pruneSnapshots keeps newest N', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-ret-'));
        const host = 'host';
        const base = path.join(root, 'metaverse-simple', host, 'hourly');
        fs.mkdirSync(path.join(base, 'a'), { recursive: true });
        fs.mkdirSync(path.join(base, 'b'), { recursive: true });
        fs.mkdirSync(path.join(base, 'c'), { recursive: true });
        const deleted = pruneSnapshots(root, host, 'hourly', 2);
        assert.equal(deleted.length, 1);
        const remaining = listSnapshotDirs(root, host, 'hourly');
        assert.equal(remaining.length, 2);
        fs.rmSync(root, { recursive: true, force: true });
    });
});
