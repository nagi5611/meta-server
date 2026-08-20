// lib/caption-segmenter.js — STT の累積 interim を発話単位に分割する
// Google ストリーミングは無音で final が来ないまま次の発話が同じ interim に連結されることがある。
// ポーズ検出と prefix 除去で、区切りごとに字幕をリセットできるようにする。

/** 無音とみなす interim 更新の間隔(ms) */
export const CAPTION_PAUSE_GAP_MS = 1200;

/**
 * @typedef {{text:string, isFinal:boolean, utteranceId:number, utteranceEnd?:boolean}} CaptionSegmentEvent
 */

export class CaptionSegmenter {
    /**
     * @param {{pauseGapMs?:number}} [opts]
     */
    constructor(opts = {}) {
        this.pauseGapMs = opts.pauseGapMs ?? CAPTION_PAUSE_GAP_MS;
        this.utteranceId = 0;
        /** Google から届いた直近の累積 interim（prefix 除去の基準） */
        this.lastGoogleInterim = '';
        this.lastInterimAt = 0;
    }

    /**
     * Google STT の transcript を発話単位の表示イベントに変換する。
     * @param {string} transcript
     * @param {boolean} isFinal
     * @param {number} [now]
     * @returns {CaptionSegmentEvent[]}
     */
    process(transcript, isFinal, now = Date.now()) {
        const text = String(transcript || '').trim();
        if (!text) return [];

        const paused = this._isPaused(now);

        if (isFinal) {
            return this._processFinal(text, paused);
        }
        return this._processInterim(text, paused, now);
    }

    /** @param {number} now */
    _isPaused(now) {
        return this.lastInterimAt > 0
            && (now - this.lastInterimAt) >= this.pauseGapMs
            && !!this.lastGoogleInterim;
    }

    /**
     * @param {string} text
     * @param {boolean} paused
     * @returns {CaptionSegmentEvent[]}
     */
    _processFinal(text, paused) {
        const events = [];
        if (paused) {
            events.push({
                text: '',
                isFinal: false,
                utteranceId: this.utteranceId,
                utteranceEnd: true,
            });
            this.utteranceId += 1;
        }

        const display = this._stripPrefix(text, paused ? this.lastGoogleInterim : '') || text;
        events.push({
            text: display,
            isFinal: true,
            utteranceId: this.utteranceId,
        });

        this.utteranceId += 1;
        this.lastGoogleInterim = '';
        this.lastInterimAt = 0;
        return events;
    }

    /**
     * @param {string} text
     * @param {boolean} paused
     * @param {number} now
     * @returns {CaptionSegmentEvent[]}
     */
    _processInterim(text, paused, now) {
        const events = [];
        if (paused) {
            events.push({
                text: '',
                isFinal: false,
                utteranceId: this.utteranceId,
                utteranceEnd: true,
            });
            this.utteranceId += 1;
        }

        const baseline = paused ? this.lastGoogleInterim : '';
        const display = this._stripPrefix(text, baseline);
        this.lastGoogleInterim = text;
        this.lastInterimAt = now;

        if (!display) return events;

        events.push({
            text: display,
            isFinal: false,
            utteranceId: this.utteranceId,
        });
        return events;
    }

    /**
     * 累積 transcript から既出部分を除いた表示用テキストを返す。
     * @param {string} text
     * @param {string} baseline
     * @returns {string}
     */
    _stripPrefix(text, baseline) {
        if (!baseline) return text;
        if (text.startsWith(baseline)) {
            return text.slice(baseline.length).trim();
        }
        return text;
    }
}
