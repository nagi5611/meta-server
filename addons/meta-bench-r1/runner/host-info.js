// addons/meta-bench-r1/runner/host-info.js — Runner ホスト情報（レポート用）
import os from 'node:os';

/**
 * @param {{ name?: string, recommendedMaxBots?: number, mediasoupMode?: string }} [opts]
 * @returns {object}
 */
export function collectRunnerHostInfo(opts = {}) {
    return {
        name: opts.name,
        hostname: os.hostname(),
        cpuModel: os.cpus()[0]?.model || 'unknown',
        cpuCores: os.cpus().length,
        totalMemGb: Math.round(os.totalmem() / 1e9),
        platform: `${os.type()} ${os.release()}`,
        nodeVersion: process.version,
        arch: os.arch(),
        mediasoupMode: opts.mediasoupMode ?? 'unknown',
        recommendedMaxBots:
            typeof opts.recommendedMaxBots === 'number' && opts.recommendedMaxBots > 0
                ? Math.floor(opts.recommendedMaxBots)
                : undefined,
        collectedAt: Date.now(),
    };
}
