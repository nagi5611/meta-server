// addons/meta-benchR1/lib/scoring.js — カテゴリスコア正規化（0–100）

/**
 * @param {number} value
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
export function clampScore(value, min = 0, max = 100) {
    return Math.max(min, Math.min(max, value));
}

/**
 * @param {number} tickPerSec
 * @param {number} [maxTps]
 * @returns {number}
 */
export function scoreMvTps(tickPerSec, maxTps = 30) {
    const diff = Math.max(0, maxTps - tickPerSec);
    return clampScore(100 * (1 - diff / 3));
}

/**
 * @param {number} cpuIncreaseRatio 0 = 変化なし, 0.5 = +50%
 * @returns {number}
 */
export function scoreCpuDegrade(cpuIncreaseRatio) {
    if (cpuIncreaseRatio <= 0) return 100;
    if (cpuIncreaseRatio >= 0.5) return 0;
    return clampScore(100 * (1 - cpuIncreaseRatio / 0.5));
}

/**
 * @param {number} pingP95Ms
 * @returns {number}
 */
export function scorePingP95(pingP95Ms) {
    if (pingP95Ms <= 50) return 100;
    if (pingP95Ms >= 300) return 0;
    return clampScore(100 * (1 - (pingP95Ms - 50) / 250));
}

/**
 * @param {{ tpsScore: number, cpuScore: number, pingScore: number }} parts
 * @returns {number}
 */
export function scoreMvDegrade(parts) {
    return clampScore(parts.tpsScore * 0.5 + parts.cpuScore * 0.3 + parts.pingScore * 0.2);
}

/**
 * @param {number} latencyMs
 * @returns {number}
 */
export function scoreDbLatency(latencyMs) {
    if (latencyMs <= 5) return 100;
    if (latencyMs >= 200) return 0;
    return clampScore(100 * (1 - (latencyMs - 5) / 195));
}

/**
 * @param {number} packetLossPct
 * @returns {number}
 */
export function scorePacketLoss(packetLossPct) {
    if (packetLossPct <= 0.5) return 100;
    if (packetLossPct >= 5) return 0;
    return clampScore(100 * (1 - (packetLossPct - 0.5) / 4.5));
}

/**
 * Voice E2E 照合一致率（0–100）をスコアに変換
 * @param {number | null | undefined} matchPct
 * @returns {number}
 */
export function scoreVoiceMatch(matchPct) {
    if (matchPct == null || !Number.isFinite(matchPct)) return 0;
    return clampScore(matchPct);
}

/**
 * @param {number} retainPct 0–100
 * @param {number} pingP95Ms
 * @returns {number}
 */
export function scoreMvConnect(retainPct, pingP95Ms) {
    const retainPart = clampScore(retainPct) * 0.6;
    const pingPart = scorePingP95(pingP95Ms) * 0.4;
    return clampScore(retainPart + pingPart);
}

/**
 * @param {Record<string, number | null | undefined>} scores
 * @param {string[]} [onlyKeys] 指定時はこれらのキーのみ平均
 * @returns {number | null}
 */
export function overallScore(scores, onlyKeys) {
    let vals = Object.values(scores).filter((v) => typeof v === 'number' && Number.isFinite(v));
    if (Array.isArray(onlyKeys) && onlyKeys.length > 0) {
        vals = onlyKeys
            .map((k) => scores[k])
            .filter((v) => typeof v === 'number' && Number.isFinite(v));
    }
    if (!vals.length) return null;
    return vals.reduce((a, b) => a + b, 0) / vals.length;
}
