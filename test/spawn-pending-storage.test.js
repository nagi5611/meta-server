// test/spawn-pending-storage.test.js — ?spawn= / ?world= クエリ保持の単体テスト
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SCRIPT = readFileSync(path.join(ROOT, 'public/js/spawn-pending-storage.js'), 'utf8');

/**
 * spawn-pending-storage.js をモック window で実行する
 * @param {{ href: string, storage?: Map<string, string> }} opts
 */
function loadSpawnPending({ href, storage = new Map() }) {
    const u = new URL(href);
    const sessionStorage = {
        getItem: (k) => (storage.has(k) ? storage.get(k) : null),
        setItem: (k, v) => { storage.set(k, v); },
        removeItem: (k) => { storage.delete(k); },
    };
    const context = {
        window: {
            location: {
                origin: u.origin,
                search: u.search,
                hash: u.hash,
                href,
            },
            metaverseSpawnPending: null,
        },
        sessionStorage,
        URL,
        URLSearchParams,
    };
    vm.createContext(context);
    vm.runInContext(SCRIPT, context);
    return { api: context.window.metaverseSpawnPending, storage };
}

describe('spawn-pending-storage', () => {
    it('appendSpawnQuery preserves ?world= from current URL on redirect', () => {
        const { api } = loadSpawnPending({
            href: 'https://example.com/?world=classroom-a',
        });
        api.captureSpawnFromUrl();
        assert.equal(api.appendSpawnQuery('/login/'), '/login/?world=classroom-a');
    });

    it('appendSpawnQuery preserves both spawn and world', () => {
        const { api } = loadSpawnPending({
            href: 'https://example.com/?spawn=abc123&world=lobby',
        });
        api.captureSpawnFromUrl();
        const out = api.appendSpawnQuery('/index.html');
        assert.ok(out.includes('spawn=abc123'));
        assert.ok(out.includes('world=lobby'));
    });

    it('getPendingWorldId falls back to sessionStorage after capture', () => {
        const storage = new Map();
        const { api } = loadSpawnPending({
            href: 'https://example.com/?world=yard',
            storage,
        });
        api.captureSpawnFromUrl();
        const { api: api2 } = loadSpawnPending({
            href: 'https://example.com/login/',
            storage,
        });
        assert.equal(api2.getPendingWorldId(), 'yard');
    });

    it('appendSpawnQuery reads #world= hash', () => {
        const { api } = loadSpawnPending({
            href: 'https://example.com/#world=roof',
        });
        api.captureSpawnFromUrl();
        assert.equal(api.appendSpawnQuery('/login/'), '/login/?world=roof');
    });
});
