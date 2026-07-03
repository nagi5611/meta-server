// addons/meta-bench-r1/runner/audio-match.js — 参照 PCM と受信 PCM の照合スコア（0–100）
import { SAMPLE_RATE } from './audio-decode.js';

const MAX_LAG_SEC = 2;
const DOWNSAMPLE_STEP = 8;

/**
 * 2 系列の正規化相互相関の最大値（-1〜1）を求める
 * @param {Float32Array} a
 * @param {Float32Array} b
 * @param {number} maxLagSamples
 * @returns {number}
 */
function maxNormalizedCorrelation(a, b, maxLagSamples) {
    const len = Math.min(a.length, b.length);
    if (len < SAMPLE_RATE / 4) return 0;

    const step = DOWNSAMPLE_STEP;
    const n = Math.floor(len / step);
    const aa = new Float32Array(n);
    const bb = new Float32Array(n);
    for (let i = 0; i < n; i++) {
        aa[i] = a[i * step];
        bb[i] = b[i * step];
    }

    const maxLag = Math.min(maxLagSamples / step, Math.floor(n / 4));

    let best = -1;
    for (let lag = -maxLag; lag <= maxLag; lag++) {
        let sum = 0;
        let sumA = 0;
        let sumB = 0;
        let count = 0;
        for (let i = 0; i < n; i++) {
            const j = i + lag;
            if (j < 0 || j >= n) continue;
            const va = aa[i];
            const vb = bb[j];
            sum += va * vb;
            sumA += va * va;
            sumB += vb * vb;
            count++;
        }
        if (count < 16 || sumA <= 1e-12 || sumB <= 1e-12) continue;
        const corr = sum / Math.sqrt(sumA * sumB);
        if (corr > best) best = corr;
    }
    return best < 0 ? 0 : best;
}

/**
 * 参照と受信 PCM の一致度を 0–100 で返す
 * @param {Float32Array} reference
 * @param {Float32Array} received
 * @returns {number}
 */
export function computeAudioMatchPct(reference, received) {
    const len = Math.min(reference.length, received.length);
    if (len < SAMPLE_RATE) return 0;

    const ref = reference.subarray(0, len);
    const rec = received.subarray(0, len);
    const corr = maxNormalizedCorrelation(ref, rec, SAMPLE_RATE * MAX_LAG_SEC);
    // 相関 0.85 以上を満点付近、0.3 以下を 0 点付近とする
    if (corr >= 0.92) return 100;
    if (corr <= 0.25) return 0;
    return Math.round(((corr - 0.25) / (0.92 - 0.25)) * 100);
}
