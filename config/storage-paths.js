import path from 'node:path';
import fs from 'node:fs';

function getEnv(name) {
    const v = process.env[name];
    return (v && typeof v === 'string' && v.trim() !== '') ? v.trim() : null;
}

function requireEnv(name) {
    const v = getEnv(name);
    if (!v) throw new Error(`[Config] Missing required env var: ${name}`);
    return v;
}

function ensureDirExists(dirPath, envName) {
    try {
        if (fs.existsSync(dirPath)) {
            const stat = fs.statSync(dirPath);
            if (!stat.isDirectory()) {
                throw new Error(`[Config] ${envName} must be a directory: ${dirPath}`);
            }
            return;
        }
        fs.mkdirSync(dirPath, { recursive: true });
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        throw new Error(`[Config] Failed to prepare directory for ${envName}: ${msg}`);
    }
}

function ensureParentDirExists(filePath, envName) {
    const parent = path.dirname(filePath);
    ensureDirExists(parent, envName);
}

function getStoragePathsFromSrcDirectory(srcDirectory) {
    const base = path.resolve(srcDirectory);
    const dataDir = path.join(base, 'data');
    return {
        SRC_DIRECTORY: base,
        DATA_DIR: dataDir,
        MODELS_DIR: path.join(base, 'models'),
        AVATARS_DIR: path.join(base, 'avatars'),
        PDFS_DIR: path.join(base, 'pdfs'),
        IMAGES_DIR: path.join(base, 'images'),
        /** IBL 用 HDR（/env/* で配信・アップロード先） */
        ENV_DIR: path.join(base, 'env'),
        WORLDS_PATH: path.join(dataDir, 'worlds.json'),
        CHARTS_PATH: path.join(dataDir, 'charts.json'),
        CHART_BGM_DIR: path.join(dataDir, 'chart-bgm'),
        DB_DIR: path.join(base, 'db'),
        SERVER_LOG_DIR: path.join(base, 'logs'),
    };
}

function getStoragePathsFromExplicitEnv() {
    const modelsDir = requireEnv('META_MODELS_DIR');
    const envOverride = getEnv('META_ENV_DIR');
    return {
        SRC_DIRECTORY: null,
        DATA_DIR: null,
        MODELS_DIR: modelsDir,
        AVATARS_DIR: path.join(path.dirname(modelsDir), 'avatars'),
        PDFS_DIR: requireEnv('META_PDFS_DIR'),
        IMAGES_DIR: requireEnv('META_IMAGES_DIR'),
        /** 未設定時は models と同階層の env（META_SRC_DIRECTORY 運用と揃える） */
        ENV_DIR: envOverride ? path.resolve(envOverride) : path.join(path.dirname(modelsDir), 'env'),
        WORLDS_PATH: requireEnv('META_WORLDS_PATH'),
        CHARTS_PATH: requireEnv('META_CHARTS_PATH'),
        CHART_BGM_DIR: path.join(path.dirname(requireEnv('META_CHARTS_PATH')), 'chart-bgm'),
        DB_DIR: requireEnv('META_DB_DIR'),
        SERVER_LOG_DIR: requireEnv('META_SERVER_LOG_DIR'),
    };
}

const srcDirectory = getEnv('META_SRC_DIRECTORY');
const resolvedStoragePaths = srcDirectory
    ? getStoragePathsFromSrcDirectory(srcDirectory)
    : getStoragePathsFromExplicitEnv();

export const STORAGE_PATHS = Object.freeze(resolvedStoragePaths);

/**
 * Validate and prepare required storage paths (mkdir as needed).
 * Called during server startup; throws on any configuration error.
 */
export function validateAndPrepareStoragePaths() {
    if (!STORAGE_PATHS.SRC_DIRECTORY) {
        // Explicit-env mode: guide user to use META_SRC_DIRECTORY (preferred)
        // (Still valid, but META_SRC_DIRECTORY is the simpler recommended setup)
    }
    if (srcDirectory && STORAGE_PATHS.SRC_DIRECTORY) {
        ensureDirExists(STORAGE_PATHS.SRC_DIRECTORY, 'META_SRC_DIRECTORY');
        ensureDirExists(STORAGE_PATHS.DATA_DIR, 'META_SRC_DIRECTORY');
    }
    ensureDirExists(STORAGE_PATHS.MODELS_DIR, 'META_MODELS_DIR');
    ensureDirExists(STORAGE_PATHS.AVATARS_DIR, 'META_AVATARS_DIR');
    ensureDirExists(STORAGE_PATHS.PDFS_DIR, 'META_PDFS_DIR');
    ensureDirExists(STORAGE_PATHS.IMAGES_DIR, 'META_IMAGES_DIR');
    ensureDirExists(STORAGE_PATHS.ENV_DIR, 'ENV_DIR');

    ensureParentDirExists(STORAGE_PATHS.WORLDS_PATH, 'META_WORLDS_PATH');
    ensureParentDirExists(STORAGE_PATHS.CHARTS_PATH, 'META_CHARTS_PATH');
    ensureDirExists(STORAGE_PATHS.CHART_BGM_DIR, 'CHART_BGM_DIR');

    ensureDirExists(STORAGE_PATHS.DB_DIR, 'META_DB_DIR');
    ensureDirExists(STORAGE_PATHS.SERVER_LOG_DIR, 'META_SERVER_LOG_DIR');
}

