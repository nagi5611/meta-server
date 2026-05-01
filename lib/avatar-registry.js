// lib/avatar-registry.js — 複数アバター Registry（avatars/_meta/avatars-registry.json）の読込・検証・GLB アニメ列挙
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { normalizedAvatarsS3KeyPrefix } from '../config/s3-assets.js';
import {
    isS3ModelsBucketConfigured,
    uploadLocalAvatarFile,
    readActiveAvatarMeta,
    setActiveAvatar,
} from './s3-avatar-assets.js';
import { MANIFEST_CACHE_CONTROL } from './s3-model-assets.js';
import { getGltfTransformIO } from './glb-texture-resize.js';

/** @typedef {{ index: number, name: string, label: string }} AvatarAnimationClipMeta */

/** avatars/_meta 配下のレジストリ JSON（posix） */
export const AVATAR_REGISTRY_REL_POSIX = '_meta/avatars-registry.json';

/** 必須のモーション種別（run はクライアント側で dash に対応させる） */
export const REQUIRED_ANIM_MAP_KEYS = ['idle', 'walk', 'jump', 'run'];

/**
 * GLB ファイル名のみを許可する
 * @param {string} name
 * @returns {string|null}
 */
function safeGlbBasenameOnly(name) {
    const bn = path.basename(String(name || '')).trim();
    if (!bn.toLowerCase().endsWith('.glb')) return null;
    if (bn.includes('..') || bn.includes('/') || bn.includes('\\')) return null;
    return bn;
}

/**
 * Registry 読込（ファイルなし／破損時は null）
 * @param {string} avatarsDirAbs
 * @returns {object|null}
 */
export function readAvatarRegistryDisk(avatarsDirAbs) {
    const abs = path.join(avatarsDirAbs, ...AVATAR_REGISTRY_REL_POSIX.split('/'));
    try {
        if (!fs.existsSync(abs)) return null;
        const raw = fs.readFileSync(abs, 'utf8');
        const j = JSON.parse(raw);
        return j && typeof j === 'object' ? j : null;
    } catch {
        return null;
    }
}

/**
 * GLB が avatarsDir 直下にあるか
 * @param {string} avatarsDirAbs
 * @param {string} filename
 */
function glbExistsOnDisk(avatarsDirAbs, filename) {
    const safe = safeGlbBasenameOnly(filename);
    if (!safe) return false;
    return fs.existsSync(path.join(avatarsDirAbs, safe));
}

/**
 * クライアントが asset-resolve で使える相対パス（prefix は CDN 構成に追従）
 * @param {string} glbFilename
 */
export function glbFilenameToClientAssetPath(glbFilename) {
    const fn = safeGlbBasenameOnly(glbFilename);
    if (!fn) return null;
    const pref = normalizedAvatarsS3KeyPrefix();
    if (pref) return `${pref}/${fn}`;
    return `avatars/${fn}`;
}

/**
 * アニメクリップ一覧（GLB バイナリから）
 * @param {Buffer} buffer
 * @returns {Promise<AvatarAnimationClipMeta[]>}
 */
export async function listAnimationClipMetasFromGlbBuffer(buffer) {
    const io = await getGltfTransformIO();
    const view = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    const doc = await io.readBinary(view);
    const anims = doc.getRoot().listAnimations();
    /** @type {Map<string, number>} */
    const nameCounts = new Map();
    for (const anim of anims) {
        const raw = typeof anim.getName === 'function' ? String(anim.getName() || '') : '';
        const base = raw.trim() || '';
        nameCounts.set(base, (nameCounts.get(base) || 0) + 1);
    }
    /** @type {Map<string, number>} */
    const seenName = new Map();
    /** @type {AvatarAnimationClipMeta[]} */
    const clips = [];
    let idx = 0;
    for (const anim of anims) {
        const raw = typeof anim.getName === 'function' ? String(anim.getName() || '').trim() : '';
        const name = raw || `animation_${idx}`;
        const dup = nameCounts.get(raw || '') ?? 1;
        const nForLabel = (seenName.get(raw || '') || 0) + 1;
        seenName.set(raw || '', nForLabel);
        const label =
            dup > 1 || !raw
                ? `${name} (#${idx})`
                : name;
        clips.push({ index: idx, name, label });
        idx++;
    }
    return clips;
}

/**
 * アニメマップが当該クリップ一覧に対して完全か
 * @param {AvatarAnimationClipMeta[]} clips
 * @param {Record<string, number>} animationMap
 */
export function animationMapKeysCompleteForClips(clips, animationMap) {
    const n = clips.length;
    if (n <= 0) return false;
    if (!animationMap || typeof animationMap !== 'object') return false;
    for (const k of REQUIRED_ANIM_MAP_KEYS) {
        const v = animationMap[k];
        if (typeof v !== 'number' || !Number.isFinite(v)) return false;
        const ii = Math.trunc(v);
        if (ii < 0 || ii >= n) return false;
    }
    return true;
}

/**
 * エントリがログイン一覧に載せられるか（マップ・ファイル実在）
 * @param {{ glbFilename: string, animationClips?: AvatarAnimationClipMeta[], animationMap?: Record<string, number> }} entry
 * @param {string} avatarsDirAbs
 */
export function entryIsSelectable(entry, avatarsDirAbs) {
    if (!entry || !safeGlbBasenameOnly(entry.glbFilename)) return false;
    if (!glbExistsOnDisk(avatarsDirAbs, entry.glbFilename)) return false;
    const clips = Array.isArray(entry.animationClips) ? entry.animationClips : [];
    const map =
        entry.animationMap && typeof entry.animationMap === 'object' ? entry.animationMap : {};
    return animationMapKeysCompleteForClips(clips, /** @type {Record<string, number>} */ (map));
}

/**
 * デフォルトエントリを一つだけにする
 * @param {AvatarRegistryFile} reg
 */
function dedupeDefaults(reg) {
    const avatars = Array.isArray(reg.avatars) ? reg.avatars : [];
    let saw = false;
    for (const a of avatars) {
        if (a.isDefault) {
            if (saw) a.isDefault = false;
            else saw = true;
        }
    }
    if (!saw && avatars.length > 0) {
        avatars[0].isDefault = true;
    }
}

/**
 * アクティブ JSON とデフォルト GLB を同期する
 * @param {string} avatarsDirAbs
 * @param {AvatarRegistryFile} reg
 */
export async function syncActiveJsonFromRegistry(avatarsDirAbs, reg) {
    const avatars = Array.isArray(reg.avatars) ? reg.avatars : [];
    const def = avatars.find((a) => a.isDefault && safeGlbBasenameOnly(a.glbFilename));
    const fn = def ? safeGlbBasenameOnly(def.glbFilename) : null;
    if (fn && glbExistsOnDisk(avatarsDirAbs, fn)) {
        await setActiveAvatar(avatarsDirAbs, fn);
        return fn;
    }
    return null;
}

/**
 * 初回のみ active.json → registry へ繰り上げ
 * @param {string} avatarsDirAbs
 * @returns {AvatarRegistryFile}
 */
function migrateLegacyActiveToRegistry(avatarsDirAbs) {
    const meta = readActiveAvatarMeta(avatarsDirAbs);
    const fn = meta && typeof meta.filename === 'string' ? safeGlbBasenameOnly(meta.filename) : null;
    /** @type {AvatarRegistryFile} */
    const reg = {
        schemaVersion: 1,
        registryVersion: 1,
        avatars: [],
    };
    if (fn && glbExistsOnDisk(avatarsDirAbs, fn)) {
        reg.avatars.push({
            id: crypto.randomUUID(),
            glbFilename: fn,
            isDefault: true,
            animationClips: [],
            animationMap: {},
        });
    }
    return reg;
}

/**
 * @typedef {{ id: string, glbFilename: string, isDefault: boolean, animationClips: AvatarAnimationClipMeta[], animationMap: Record<string, number> }} AvatarRegistryEntry
 */

/**
 * @typedef {{ schemaVersion: number, registryVersion: number, avatars: AvatarRegistryEntry[] }} AvatarRegistryFile
 */

/**
 * ディスク状態を正規化し必要なら保存する
 * @param {string} avatarsDirAbs
 * @returns {Promise<AvatarRegistryFile>}
 */
export async function loadOrInitializeAvatarRegistry(avatarsDirAbs) {
    /** @type {AvatarRegistryFile | null} */
    let reg = readAvatarRegistryDisk(avatarsDirAbs);
    if (!reg || typeof reg.registryVersion !== 'number') {
        reg = migrateLegacyActiveToRegistry(avatarsDirAbs);
        await persistAvatarRegistryFile(avatarsDirAbs, reg);
        await syncActiveJsonFromRegistry(avatarsDirAbs, reg);
        return reg;
    }
    if (!Array.isArray(reg.avatars)) reg.avatars = [];
    if (typeof reg.registryVersion !== 'number' || !Number.isFinite(reg.registryVersion)) {
        reg.registryVersion = 1;
    }
    if (!reg.schemaVersion) reg.schemaVersion = 1;
    dedupeDefaults(reg);
    for (const a of reg.avatars) {
        if (!safeGlbBasenameOnly(a.glbFilename)) continue;
        if (!glbExistsOnDisk(avatarsDirAbs, a.glbFilename)) continue;
        if (Array.isArray(a.animationClips) && a.animationClips.length > 0) continue;
        const abs = path.join(avatarsDirAbs, safeGlbBasenameOnly(a.glbFilename));
        try {
            const buf = await fs.promises.readFile(abs);
            a.animationClips = await listAnimationClipMetasFromGlbBuffer(buf);
        } catch {
            a.animationClips = [];
        }
        clearInvalidAnimationMap(a);
    }
    await persistAvatarRegistryFile(avatarsDirAbs, reg);
    await syncActiveJsonFromRegistry(avatarsDirAbs, reg);
    return reg;
}

/**
 * クリップ一覧と整合しないマップ項目を削除する
 * @param {AvatarRegistryEntry} entry
 */
export function clearInvalidAnimationMap(entry) {
    const clips = Array.isArray(entry.animationClips) ? entry.animationClips : [];
    const n = clips.length;
    if (!entry.animationMap || typeof entry.animationMap !== 'object') entry.animationMap = {};
    if (n <= 0) {
        entry.animationMap = {};
        return;
    }
    for (const key of REQUIRED_ANIM_MAP_KEYS) {
        const v = entry.animationMap[key];
        if (typeof v !== 'number' || !Number.isFinite(v)) {
            delete entry.animationMap[key];
            continue;
        }
        const ii = Math.trunc(v);
        if (ii < 0 || ii >= n) delete entry.animationMap[key];
        else entry.animationMap[key] = ii;
    }
}

/**
 * レジストリを書き込み、S3 利用時はアップロードする
 * @param {string} avatarsDirAbs
 * @param {AvatarRegistryFile} reg
 */
export async function persistAvatarRegistryFile(avatarsDirAbs, reg) {
    const abs = path.join(avatarsDirAbs, ...AVATAR_REGISTRY_REL_POSIX.split('/'));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    reg.schemaVersion = 1;
    const jsonStr = `${JSON.stringify(reg, null, 0)}\n`;
    await fs.promises.writeFile(abs, jsonStr, 'utf8');
    if (!isS3ModelsBucketConfigured()) return;
    try {
        await uploadLocalAvatarFile(abs, avatarsDirAbs, MANIFEST_CACHE_CONTROL);
    } catch (e) {
        console.error('[avatar-registry] S3 persist registry:', e);
    }
}

/**
 * アップロード直後など clips を最新化してマップを検証する
 * @param {AvatarRegistryEntry} entry
 * @param {Buffer} glbBuffer
 */
export async function refreshEntryClipMetas(entry, glbBuffer) {
    entry.animationClips = await listAnimationClipMetasFromGlbBuffer(glbBuffer);
    clearInvalidAnimationMap(entry);
}

/**
 * @param {AvatarRegistryFile} reg
 * @param {string} id
 */
export function getAvatarEntryById(reg, id) {
    const want = String(id || '').trim();
    return reg.avatars?.find((a) => a.id === want) || null;
}

/**
 * ログイン用に検証済み ID を返す（不正・未指定時はデフォルト）
 * @param {AvatarRegistryFile} reg
 * @param {string} avatarsDirAbs
 * @param {unknown} requestedId
 */
export function resolveSelectableAvatarId(reg, avatarsDirAbs, requestedId) {
    const def = reg.avatars?.find((e) => e.isDefault);
    const defOk = def && entryIsSelectable(def, avatarsDirAbs) ? def.id : null;
    const rid = String(requestedId || '').trim();
    if (!rid && defOk) return defOk;
    const cand = rid ? getAvatarEntryById(reg, rid) : null;
    if (cand && entryIsSelectable(cand, avatarsDirAbs)) return cand.id;
    if (defOk) return defOk;
    const any = reg.avatars?.find((e) => entryIsSelectable(e, avatarsDirAbs));
    return any ? any.id : null;
}

/**
 * PATCH 時の楽観ロック比較
 * @param {AvatarRegistryFile} reg
 * @param {unknown} incomingVersion
 */
export function registryVersionMatches(reg, incomingVersion) {
    const v = Number(incomingVersion);
    if (!Number.isFinite(v)) return false;
    return Math.trunc(v) === Math.trunc(reg.registryVersion);
}
