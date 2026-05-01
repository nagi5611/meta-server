// lib/model-manifest.js — models/ 以下のモデル資産マニフェスト（差分ダウンロード・論理パス解決）

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
/** models 直下に保存するマニフェスト JSON（一覧 API では .glb/.obj のみ対象とし本ファイルは表示されない運用でも可） */
export const MODEL_ASSET_MANIFEST_FILENAME = 'model-asset-manifest.json';

const SCHEMA_VERSION = 1;

/**
 * 環境変数が真ならモデルファイルの SHA-256 をマニフェストに格納（大容量ではアップロードが遅延しうる）
 * @returns {boolean}
 */
export function envModelManifestComputeHash() {
    const s = String(process.env.MODEL_MANIFEST_COMPUTE_HASH || '').trim().toLowerCase();
    return ['1', 'true', 'yes', 'on'].includes(s);
}

/**
 * 環境変数が真ならアップロード時に `name.<hash>.ext` 形式のファイル名を採用（immutable cache 前提）
 * @returns {boolean}
 */
export function envUseModelContentHashFilenames() {
    const s = String(process.env.USE_MODEL_CONTENT_HASH_FILENAMES || '').trim().toLowerCase();
    return ['1', 'true', 'yes', 'on'].includes(s);
}

/**
 * @param {string} relPosix models からの相対（例 Lobby_v_xx.glb または sub/a.glb）
 * @returns {string} models/ で始まる論理パス
 */
export function toModelsLogicalPrefix(relPosix) {
    const clean = String(relPosix || '')
        .replace(/\\/g, '/')
        .replace(/^\/+/, '');
    return clean.startsWith('models/') ? clean : `models/${clean}`;
}

/**
 *ファイル名から `_v_<token>` を除いた論理ファイル名を得る（なければ元の名前）
 * @param {string} basename
 * @returns {string}
 */
export function basenameWithoutUploadVersionToken(basename) {
    const m = /^(.+)_v_[a-z0-9_.+-]{4,}(\.[^./]+)$/i.exec(basename);
    return m ? m[1] + m[2] : basename;
}

/**
 * 内容ハッシュ付き名前 `stem.<hex>.ext` を論理名 `stem.ext` に戻す
 * @param {string} basename
 * @returns {string|null} 変換できなければ null
 */
export function basenameWithoutContentHashInjection(basename) {
    const m = /^(.+)\.([a-f0-9]{12,64})\.(glb|obj)$/i.exec(basename);
    return m ? `${m[1]}.${m[3]}` : null;
}

/**
 * @param {string} relPosix models からの相対 POSIX
 * @returns {string}
 */
export function deriveDefaultLogicalModelsPath(relPosix) {
    const rel = String(relPosix || '').replace(/\\/g, '/').replace(/^\/+/, '');
    const base = path.posix.basename(rel);
    let logicalBase = basenameWithoutUploadVersionToken(base);
    const maybeStrippedHash = basenameWithoutContentHashInjection(logicalBase);
    if (maybeStrippedHash) logicalBase = maybeStrippedHash;
    const dir = path.posix.dirname(rel);
    if (dir === '.' || dir === '') {
        return toModelsLogicalPrefix(logicalBase);
    }
    return toModelsLogicalPrefix(`${dir}/${logicalBase}`);
}

/**
 * @typedef {object} ModelManifestStoredEntry
 * @property {string} logicalPath models/ で始まる論理パス
 * @property {string} resolvedPath models/ で始まる実ファイル相対パス
 * @property {string} version クライアントキャッシュ無効化用の版（mtime+size または content-hash）
 * @property {string | null} contentHash sha256 hex または null
 * @property {number} size
 * @property {string} updatedAt ISO8601
 */

/**
 * @param {string} modelsDir 絶対パス
 * @returns {string}
 */
function manifestAbsPath(modelsDir) {
    return path.join(modelsDir, MODEL_ASSET_MANIFEST_FILENAME);
}

/**
 * バッファまたはファイルパスから sha256 を得る（未使用時は null）
 * @param {{ buffer?: Buffer | null, absPath?: string | null, computeHash: boolean }} opts
 * @returns {Promise<string | null>}
 */
async function computeSha256HexOptional(opts) {
    if (!opts.computeHash) return null;
    if (opts.buffer && Buffer.isBuffer(opts.buffer)) {
        const h = crypto.createHash('sha256').update(opts.buffer).digest('hex');
        return h;
    }
    if (opts.absPath && fs.existsSync(opts.absPath)) {
        const hash = crypto.createHash('sha256');
        await new Promise((resolve, reject) => {
            const st = fs.createReadStream(opts.absPath);
            st.on('error', reject);
            st.on('data', (c) => hash.update(c));
            st.on('end', resolve);
        });
        return hash.digest('hex');
    }
    return null;
}

/** @typedef {{ schemaVersion: number, byResolved: Record<string, ModelManifestStoredEntry> }} ModelManifestFile */

/**
 * @param {string} modelsDir
 * @returns {ModelManifestFile}
 */
export function readModelManifest(modelsDir) {
    const abs = manifestAbsPath(modelsDir);
    if (!fs.existsSync(abs)) {
        return { schemaVersion: SCHEMA_VERSION, byResolved: {} };
    }
    try {
        const raw = JSON.parse(fs.readFileSync(abs, 'utf8'));
        if (!raw || typeof raw !== 'object') {
            return { schemaVersion: SCHEMA_VERSION, byResolved: {} };
        }
        const byResolved =
            raw.byResolved && typeof raw.byResolved === 'object'
                ? /** @type {Record<string, ModelManifestStoredEntry>} */ (raw.byResolved)
                : {};
        return { schemaVersion: SCHEMA_VERSION, byResolved };
    } catch {
        return { schemaVersion: SCHEMA_VERSION, byResolved: {} };
    }
}

/**
 * アトミック書き換えでマニフェストを保存する
 * @param {string} modelsDir
 * @param {ModelManifestFile} data
 */
export function writeModelManifest(modelsDir, data) {
    if (!fs.existsSync(modelsDir)) {
        fs.mkdirSync(modelsDir, { recursive: true });
    }
    const abs = manifestAbsPath(modelsDir);
    const tmp = `${abs}.${process.pid}.${Date.now()}.tmp`;
    const payload = JSON.stringify(
        { schemaVersion: SCHEMA_VERSION, byResolved: data.byResolved },
        null,
        2
    );
    fs.writeFileSync(tmp, payload, 'utf8');
    fs.renameSync(tmp, abs);
}

/**
 * logicalPath と重複する古い実体を byResolved から除去する（同一論理への新アップロード時）
 * @param {Record<string, ModelManifestStoredEntry>} map
 * @param {string} logicalPath
 * @param {string} keepResolvedRel posix models/ 無しまたは付き両対応で比較
 */
function pruneSameLogicalExcludeResolved(map, logicalPath, keepResolvedRel) {
    const logical = toModelsLogicalPrefix(logicalPath);
    const keepNorm = normalizeResolvedKey(keepResolvedRel);
    for (const key of Object.keys(map)) {
        const ent = map[key];
        if (!ent || typeof ent.logicalPath !== 'string') continue;
        if (toModelsLogicalPrefix(ent.logicalPath) !== logical) continue;
        if (normalizeResolvedKey(ent.resolvedPath) === keepNorm) continue;
        delete map[key];
    }
}

/**
 * @param {string} resolvedPath
 */
function normalizeResolvedKey(resolvedPath) {
    let s = String(resolvedPath || '').replace(/\\/g, '/').replace(/^\/+/, '');
    if (s.toLowerCase().startsWith('models/')) s = s.slice('models/'.length);
    return s;
}

/**
 * @param {string} logicalPath
 * @param {string} resolvedRel posix（models/ 無しでも可）
 * @param {{ size: number, mtimeMs: number, contentHash: string | null }} meta
 * @returns {ModelManifestStoredEntry}
 */
function buildEntry(logicalPath, resolvedRel, meta) {
    const resolvedNorm = normalizeResolvedKey(resolvedRel);
    const version =
        meta.contentHash && meta.contentHash.length >= 16
            ? meta.contentHash.slice(0, 16)
            : `${Math.floor(meta.mtimeMs)}_${meta.size}`;
    return {
        logicalPath: toModelsLogicalPrefix(logicalPath),
        resolvedPath: toModelsLogicalPrefix(resolvedNorm),
        version,
        contentHash: meta.contentHash,
        size: meta.size,
        updatedAt: new Date(meta.mtimeMs).toISOString(),
    };
}

/**
 * 単一モデルのアップロード確定後にマニフェストを更新する
 * @param {string} modelsDir
 * @param {{ logicalFilename: string, resolvedRelativePosix: string, buffer?: Buffer | null }} spec
 */
export async function manifestUpsertUploadedModel(modelsDir, spec) {
    const logicalFilename = String(spec.logicalFilename || '').replace(/\\/g, '/').replace(/^\/+/, '');
    const logicalPath = toModelsLogicalPrefix(logicalFilename);
    const resolvedRelRaw = String(spec.resolvedRelativePosix || '').replace(/\\/g, '/');
    const resolvedKey = normalizeResolvedKey(resolvedRelRaw);

    const abs = path.join(modelsDir, resolvedKey);
    if (!fs.existsSync(abs)) {
        return;
    }
    let st;
    try {
        st = fs.statSync(abs);
    } catch {
        return;
    }
    const computeHash = envModelManifestComputeHash();
    const contentHash =
        spec.buffer && Buffer.isBuffer(spec.buffer)
            ? await computeSha256HexOptional({ buffer: spec.buffer, computeHash })
            : await computeSha256HexOptional({ absPath: abs, computeHash });

    const snapshot = readModelManifest(modelsDir);
    pruneSameLogicalExcludeResolved(snapshot.byResolved, logicalPath, resolvedKey);
    const ent = buildEntry(logicalPath, resolvedKey, {
        size: st.size,
        mtimeMs: st.mtimeMs,
        contentHash,
    });
    snapshot.byResolved[resolvedKey] = ent;
    writeModelManifest(modelsDir, snapshot);
}

/**
 * ディスクから除去された resolved パスに対応するマニフェスト条項を削除する
 * @param {string} modelsDir
 * @param {string[]} relativePaths models からの相対（POSIX、models/ 接頭辞可）
 */
export function manifestRemoveByResolvedPaths(modelsDir, relativePaths) {
    if (!relativePaths.length) return;
    const snapshot = readModelManifest(modelsDir);
    let changed = false;
    for (const rp of relativePaths) {
        const key = normalizeResolvedKey(rp);
        if (snapshot.byResolved[key]) {
            delete snapshot.byResolved[key];
            changed = true;
        }
    }
    if (changed) {
        writeModelManifest(modelsDir, snapshot);
    }
}

/**
 * 再帰的にモデル関連ファイルのみ列挙（.glb / .obj）、マニフェスト自身と prefab-manifest JSON は除外
 * @param {string} modelsDir
 * @param {string} [subdir]
 * @returns {Generator<string>}
 */
export function *walkModelAssetRelativePaths(modelsDir, subdir = '') {
    const base = path.join(modelsDir, subdir);
    if (!fs.existsSync(base)) return;
    const ents = fs.readdirSync(base, { withFileTypes: true });
    for (const d of ents) {
        const relJoin = subdir ? `${subdir.replace(/\\/g, '/')}/${d.name}` : d.name;
        const abs = path.join(base, d.name);
        const low = d.name.toLowerCase();
        if (d.isDirectory()) {
            yield* walkModelAssetRelativePaths(modelsDir, relJoin);
        } else if (low === MODEL_ASSET_MANIFEST_FILENAME.toLowerCase()) {
            continue;
        } else if (low.endsWith('.glb') || low.endsWith('.obj')) {
            yield relJoin.replace(/\\/g, '/');
        }
    }
}

/**
 * 永続データとディスク走査をマージし GET /api/model-manifest の items を返す
 * @param {string} modelsDir
 * @returns {{ items: Omit<ModelManifestStoredEntry, never>[], manifestGeneration: number }}
 */
export function buildModelManifestCatalog(modelsDir) {
    const persisted = readModelManifest(modelsDir);
    /** @type {Map<string, ModelManifestStoredEntry>} keyed by normalized resolved without models prefix */
    const byKey = new Map();

    for (const [k, ent] of Object.entries(persisted.byResolved || {})) {
        if (!ent || typeof ent.resolvedPath !== 'string') continue;
        const nk = normalizeResolvedKey(ent.resolvedPath || k);
        byKey.set(nk, ent);
    }

    for (const rel of walkModelAssetRelativePaths(modelsDir)) {
        const nk = normalizeResolvedKey(rel);
        if (byKey.has(nk)) continue;
        const abs = path.join(modelsDir, nk);
        let st;
        try {
            st = fs.statSync(abs);
        } catch {
            continue;
        }
        const syntheticLogical = deriveDefaultLogicalModelsPath(nk);
        const ent = buildEntry(syntheticLogical, nk, {
            size: st.size,
            mtimeMs: st.mtimeMs,
            contentHash: null,
        });
        byKey.set(nk, ent);
    }

    /** @type {ModelManifestStoredEntry[]} */
    const items = [...byKey.values()].sort((a, b) =>
        a.logicalPath.localeCompare(b.logicalPath, undefined, { sensitivity: 'base' })
    );

    /** 世代番号として schema + 条項数 + 最大 mtime で簡易安定ハッシュがわり */
    const maxMtime = items.reduce((m, it) => {
        const t = Date.parse(it.updatedAt);
        return Number.isFinite(t) && t > m ? t : m;
    }, 0);
    const manifestGeneration = SCHEMA_VERSION * 1000000 + items.length * 997 + Math.floor(maxMtime % 1e9);

    return { items, manifestGeneration };
}
