// addons/meta-bench-r1/lib/bench-audio-path.js — ベンチ用参照音声パス
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const LIB_DIR = path.dirname(fileURLToPath(import.meta.url));
/** metaverse-simple リポジトリ root */
export const PROJECT_ROOT = path.resolve(LIB_DIR, '../../..');

const DEFAULT_BENCH_AUDIO = 'public/music/bench_sample.mp3';

/**
 * ベンチ E2E 照合用 MP3 の絶対パスを返す
 * @param {string} [relativeOrAbsolute]
 * @returns {string}
 */
export function resolveBenchAudioPath(relativeOrAbsolute) {
    const raw =
        typeof relativeOrAbsolute === 'string' && relativeOrAbsolute.trim()
            ? relativeOrAbsolute.trim()
            : DEFAULT_BENCH_AUDIO;
    if (path.isAbsolute(raw)) return raw;
    return path.resolve(PROJECT_ROOT, raw.replace(/\\/g, '/'));
}
