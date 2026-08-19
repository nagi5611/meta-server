// test/captions-log.test.js — captions_log DB の単体テスト
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// storage-paths.js は import 時に META_SRC_DIRECTORY を要求するため、動的 import 前に設定
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'captions-test-'));
process.env.META_SRC_DIRECTORY = TMP_ROOT;

let mod;
before(async () => {
    mod = await import('../db/captions-log.js');
    mod.initCaptionsLogDb();
});

describe('captions-log DB', () => {
    it('insert / getCaptionsPaginated が動作する', () => {
        mod.insertCaptionLog({ roomId: 'lobby', peerId: 'p1', username: 'Alice', transcript: 'こんにちは' });
        mod.insertCaptionLog({ roomId: 'lobby', peerId: 'p2', username: 'Bob', transcript: 'テストです' });
        mod.insertCaptionLog({ roomId: 'school', peerId: 'p3', username: 'Carol', transcript: '別ルーム' });

        const all = mod.getCaptionsPaginated(1, 50);
        assert.equal(all.total, 3);

        const lobbyOnly = mod.getCaptionsPaginated(1, 50, 'lobby');
        assert.equal(lobbyOnly.total, 2);
        assert.ok(lobbyOnly.captions.every((c) => c.room_id === 'lobby'));
        // created_at DESC（新しい順）
        assert.equal(lobbyOnly.captions[0].username, 'Bob');
    });

    it('空文字の transcript は保存しない', () => {
        const before = mod.getCaptionsPaginated(1, 50).total;
        mod.insertCaptionLog({ roomId: 'lobby', peerId: 'p1', username: 'Alice', transcript: '   ' });
        const after = mod.getCaptionsPaginated(1, 50).total;
        assert.equal(after, before);
    });

    it('保持期間より古いレコードは insert 後に削除される', () => {
        // 40 日前の created_at を直接入れ、新規 insert（retention 既定 30 日）でパージされることを確認
        mod.insertCaptionLog({
            roomId: 'lobby', peerId: 'old', username: 'Old', transcript: '古い発話',
            createdAt: Date.now() - 40 * 24 * 60 * 60 * 1000,
        });
        // 新規 insert が deleteOlderThanDays を呼ぶ
        mod.insertCaptionLog({ roomId: 'lobby', peerId: 'p9', username: 'New', transcript: '新しい発話' });
        const rows = mod.getCaptionsPaginated(1, 200).captions;
        assert.ok(!rows.some((c) => c.username === 'Old'), '40日前の発話は削除される');
        assert.ok(rows.some((c) => c.username === 'New'));
    });
});
