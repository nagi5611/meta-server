import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('backup-scopes', () => {
    it('defaultScopeForKind maps hourly to state and daily to full', async () => {
        process.env.META_SRC_DIRECTORY = process.env.META_SRC_DIRECTORY || '/tmp/meta-test-src';
        const { defaultScopeForKind } = await import('../lib/backup-scopes.js');
        assert.equal(defaultScopeForKind('hourly'), 'state');
        assert.equal(defaultScopeForKind('daily'), 'full');
    });
});
