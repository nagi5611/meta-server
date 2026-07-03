// addons/meta-bench-r1/lib/bench-phases.js — ベンチ実行フェーズ定義

/** @type {{ id: string, label: string, scoreKeys: string[] }[]} */
export const BENCH_PHASE_DEFS = [
    { id: 'hw', label: 'HW（CPU / メモリ）', scoreKeys: ['hw-cpu', 'hw-mem'] },
    {
        id: 'socket-bots',
        label: 'MV 接続・TPS（socket-bots）',
        scoreKeys: ['mv-connect', 'mv-tps', 'mv-degrade'],
    },
    { id: 'db-sqlite', label: 'DB（SQLite）', scoreKeys: ['db-sqlite'] },
    { id: 'audio-vc', label: '音声 VC（audio-vc）', scoreKeys: ['audio-vc'] },
];

/** @type {string[]} */
export const DEFAULT_BENCH_PHASES = BENCH_PHASE_DEFS.map((p) => p.id);

/**
 * @param {unknown} input
 * @returns {string[]}
 */
export function normalizeBenchPhases(input) {
    if (!Array.isArray(input) || input.length === 0) {
        return [...DEFAULT_BENCH_PHASES];
    }
    const valid = new Set(BENCH_PHASE_DEFS.map((p) => p.id));
    const out = [];
    for (const item of input) {
        if (typeof item === 'string' && valid.has(item) && !out.includes(item)) {
            out.push(item);
        }
    }
    return out.length ? out : [...DEFAULT_BENCH_PHASES];
}

/**
 * @param {string[]} phases
 * @param {string} phaseId
 * @returns {boolean}
 */
export function isBenchPhaseEnabled(phases, phaseId) {
    return phases.includes(phaseId);
}

/**
 * @param {string[]} phases
 * @returns {string[]}
 */
export function scoreKeysForPhases(phases) {
    const keys = [];
    for (const def of BENCH_PHASE_DEFS) {
        if (phases.includes(def.id)) {
            for (const k of def.scoreKeys) {
                if (!keys.includes(k)) keys.push(k);
            }
        }
    }
    return keys;
}
