// public/js/world-quality-lod.js — 品質 LOD（論理ワールド内の models 品質段階）

/**
 * qualityLods オブジェクトを取得する
 * @param {Record<string, unknown>|null|undefined} world
 * @returns {Record<string, { label?: string, models?: unknown[], pdfs?: unknown[] }>|null}
 */
export function getQualityLodsObject(world) {
    if (!world || typeof world !== 'object') return null;
    const ql = world.qualityLods;
    if (!ql || typeof ql !== 'object' || Array.isArray(ql)) return null;
    return /** @type {Record<string, { label?: string, models?: unknown[], pdfs?: unknown[] }>} */ (ql);
}

/**
 * qualityLods に定義されたキー一覧（数値順。models の有無は問わない）
 * @param {Record<string, unknown>|null|undefined} world
 * @returns {string[]}
 */
export function getQualityLodEditorKeys(world) {
    const ql = getQualityLodsObject(world);
    if (!ql) return [];
    return Object.keys(ql)
        .filter((k) => {
            const entry = ql[k];
            return entry && typeof entry === 'object';
        })
        .sort((a, b) => {
            const na = Number(a);
            const nb = Number(b);
            if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
            return String(a).localeCompare(String(b), undefined, { numeric: true });
        });
}

/** @deprecated エイリアス — 定義済み LOD キー一覧 */
export function getQualityLodKeys(world) {
    return getQualityLodEditorKeys(world);
}

/**
 * 入室時ポップアップが必要か（2 件以上の LOD 定義）
 * @param {Record<string, unknown>|null|undefined} world
 * @returns {boolean}
 */
export function hasMultipleQualityLods(world) {
    return getQualityLodEditorKeys(world).length >= 2;
}

/**
 * 品質 LOD の表示ラベル
 * @param {Record<string, unknown>|null|undefined} world
 * @param {string} key
 * @returns {string}
 */
export function getQualityLodLabel(world, key) {
    const ql = getQualityLodsObject(world);
    const entry = ql && ql[key];
    const custom = entry && typeof entry.label === 'string' ? entry.label.trim() : '';
    if (custom) return custom;
    return `LOD${key}`;
}

/**
 * 品質 LOD ボタン用の表示文言（LOD{n} — label）
 * @param {Record<string, unknown>|null|undefined} world
 * @param {string} key
 * @returns {string}
 */
export function formatQualityLodButtonLabel(world, key) {
    const ql = getQualityLodsObject(world);
    const entry = ql && ql[key];
    const custom = entry && typeof entry.label === 'string' ? entry.label.trim() : '';
    if (custom) return `LOD${key} — ${custom}`;
    return `LOD${key}`;
}

/**
 * 品質 LOD 用の models 配列を取得（未設定時はルート models）
 * @param {Record<string, unknown>|null|undefined} world
 * @param {string|null|undefined} lodKey
 * @returns {unknown[]}
 */
export function getQualityLodModels(world, lodKey) {
    if (!world || typeof world !== 'object') return [];
    const key = lodKey != null ? String(lodKey).trim() : '';
    if (key) {
        const ql = getQualityLodsObject(world);
        const entry = ql && ql[key];
        if (entry && Array.isArray(entry.models)) return entry.models;
    }
    return Array.isArray(world.models) ? world.models : [];
}

/**
 * 品質 LOD 用の pdfs 配列（LOD 別があれば優先、なければルート）
 * @param {Record<string, unknown>|null|undefined} world
 * @param {string|null|undefined} lodKey
 * @returns {unknown[]}
 */
export function getQualityLodPdfs(world, lodKey) {
    if (!world || typeof world !== 'object') return [];
    const key = lodKey != null ? String(lodKey).trim() : '';
    if (key) {
        const ql = getQualityLodsObject(world);
        const entry = ql && ql[key];
        if (entry && Array.isArray(entry.pdfs)) return entry.pdfs;
    }
    return Array.isArray(world.pdfs) ? world.pdfs : [];
}

/**
 * 表示用ワールド設定を合成する（論理ワールド共通 + LOD 別 models/pdfs）
 * @param {Record<string, unknown>|null|undefined} world
 * @param {string|null|undefined} lodKey
 * @returns {Record<string, unknown>|null}
 */
export function resolveWorldForQualityLod(world, lodKey) {
    if (!world || typeof world !== 'object') return null;
    const key = lodKey != null ? String(lodKey).trim() : '';
    const models = getQualityLodModels(world, key || null);
    const pdfs = getQualityLodPdfs(world, key || null);
    return {
        ...world,
        models: Array.isArray(models) ? models.map((m) => (m && typeof m === 'object' ? { ...m } : m)) : [],
        pdfs: Array.isArray(pdfs) ? pdfs.map((p) => (p && typeof p === 'object' ? { ...p } : p)) : [],
        _qualityLodKey: key || null,
    };
}

/**
 * 全ワールドに LOD1 を保証し、ルート models と同期する
 * @param {Record<string, unknown>} world
 */
export function ensureWorldQualityLod1(world) {
    if (!world || typeof world !== 'object') return;
    const rootModels = Array.isArray(world.models) ? world.models : [];

    if (!world.qualityLods || typeof world.qualityLods !== 'object' || Array.isArray(world.qualityLods)) {
        world.qualityLods = {};
    }
    const ql = /** @type {Record<string, { label?: string, models?: unknown[] }>} */ (world.qualityLods);

    if (!ql['1'] || typeof ql['1'] !== 'object') {
        ql['1'] = {
            label: '',
            models: rootModels.map((m) => (m && typeof m === 'object' ? { ...m } : m)),
        };
    } else {
        const entry = ql['1'];
        if (typeof entry.label !== 'string') entry.label = '';
        if (!Array.isArray(entry.models)) entry.models = [];
        if (entry.models.length === 0 && rootModels.length > 0) {
            entry.models = rootModels.map((m) => (m && typeof m === 'object' ? { ...m } : m));
        }
    }

    const lod1Models = ql['1'].models;
    if (Array.isArray(lod1Models) && lod1Models.length > 0) {
        world.models = lod1Models.map((m) => (m && typeof m === 'object' ? { ...m } : m));
    }
}

/**
 * 品質 LOD エントリの骨格を保証する
 * @param {Record<string, unknown>} world
 * @param {string} key
 */
export function ensureQualityLodEntry(world, key) {
    if (!world || typeof world !== 'object') return;
    if (!world.qualityLods || typeof world.qualityLods !== 'object' || Array.isArray(world.qualityLods)) {
        world.qualityLods = {};
    }
    const ql = /** @type {Record<string, unknown>} */ (world.qualityLods);
    if (!ql[key] || typeof ql[key] !== 'object') {
        ql[key] = { label: '', models: [] };
    }
    const entry = /** @type {Record<string, unknown>} */ (ql[key]);
    if (typeof entry.label !== 'string') entry.label = '';
    if (!Array.isArray(entry.models)) entry.models = [];
}
