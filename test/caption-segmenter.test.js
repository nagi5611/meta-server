// test/caption-segmenter.test.js — 発話区切り字幕の単体テスト
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CaptionSegmenter, CAPTION_PAUSE_GAP_MS } from '../lib/caption-segmenter.js';

describe('CaptionSegmenter', () => {
    it('同一発話内では interim が累積表示される', () => {
        const seg = new CaptionSegmenter();
        const t0 = 1_000_000;
        const first = seg.process('こんにちは', false, t0);
        assert.deepEqual(first, [{
            text: 'こんにちは',
            isFinal: false,
            utteranceId: 0,
        }]);

        const second = seg.process('こんにちは世界', false, t0 + 200);
        assert.deepEqual(second, [{
            text: 'こんにちは世界',
            isFinal: false,
            utteranceId: 0,
        }]);
    });

    it('ポーズ後の interim は前の文を切り離して新規発話として扱う', () => {
        const seg = new CaptionSegmenter();
        const t0 = 2_000_000;
        seg.process('おはよう', false, t0);
        const gap = CAPTION_PAUSE_GAP_MS + 50;
        const afterPause = seg.process('おはようさようなら', false, t0 + gap);

        assert.equal(afterPause.length, 2);
        assert.deepEqual(afterPause[0], {
            text: '',
            isFinal: false,
            utteranceId: 0,
            utteranceEnd: true,
        });
        assert.deepEqual(afterPause[1], {
            text: 'さようなら',
            isFinal: false,
            utteranceId: 1,
        });
    });

    it('final で発話を確定し utteranceId を進める', () => {
        const seg = new CaptionSegmenter();
        const t0 = 3_000_000;
        seg.process('テスト', false, t0);
        const finals = seg.process('テスト完了', true, t0 + 300);

        assert.deepEqual(finals, [{
            text: 'テスト完了',
            isFinal: true,
            utteranceId: 0,
        }]);

        const next = seg.process('次', false, t0 + 400);
        assert.deepEqual(next, [{
            text: '次',
            isFinal: false,
            utteranceId: 1,
        }]);
    });

    it('ポーズ後の final は新規部分だけを確定する', () => {
        const seg = new CaptionSegmenter();
        const t0 = 4_000_000;
        seg.process('A', false, t0);
        const gap = CAPTION_PAUSE_GAP_MS + 100;
        const finals = seg.process('A B', true, t0 + gap);

        assert.equal(finals.length, 2);
        assert.equal(finals[0].utteranceEnd, true);
        assert.deepEqual(finals[1], {
            text: 'B',
            isFinal: true,
            utteranceId: 1,
        });
    });
});
