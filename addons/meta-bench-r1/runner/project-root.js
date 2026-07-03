// addons/meta-bench-r1/runner/project-root.js — Runner からリポジトリ root の node_modules を参照する
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const RUNNER_DIR = path.dirname(fileURLToPath(import.meta.url));

/** metaverse-simple リポジトリ root（addons/meta-bench-r1/runner から 3 階層上） */
export const PROJECT_ROOT = path.resolve(RUNNER_DIR, '../../..');

const requireFromRunner = createRequire(import.meta.url);

/**
 * リポジトリ root の node_modules からパッケージを解決する
 * @param {string} packageName
 * @returns {string | null} 絶対パス（エントリファイル）
 */
export function resolvePackageFromProjectRoot(packageName) {
    try {
        return requireFromRunner.resolve(packageName, { paths: [PROJECT_ROOT] });
    } catch {
        return null;
    }
}
