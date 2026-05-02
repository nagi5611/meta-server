import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { getGltfTransformIO } from './glb-texture-resize.js';
import { readActiveAvatarMeta, setActiveAvatar } from './s3-avatar-assets.js';

export const AVATAR_REGISTRY_REL_POSIX = '_meta/avatars-registry.json';
export const AVATAR_REQUIRED_MAP_KEYS = ['walk', 'jump', 'idle', 'run'];

function safeGlbFilename(v) {
    const bn = path.basename(String(v || '').trim());
    if (!bn.toLowerCase().endsWith('.glb')) return '';
    if (bn.includes('/') || bn.includes('\\') || bn.includes('..')) return '';
    return bn;
}

function registryAbsPath(avatarsDir) {
    return path.join(avatarsDir, ...AVATAR_REGISTRY_REL_POSIX.split('/'));
}

export function readAvatarRegistry(avatarsDir) {
    const abs = registryAbsPath(avatarsDir);
    try {
        if (!fs.existsSync(abs)) return null;
        const raw = fs.readFileSync(abs, 'utf8');
        const j = JSON.parse(raw);
        return j && typeof j === 'object' ? j : null;
    } catch {
        return null;
    }
}

export function writeAvatarRegistry(avatarsDir, registry) {
    const abs = registryAbsPath(avatarsDir);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, `${JSON.stringify(registry)}\n`, 'utf8');
}

function avatarFileExists(avatarsDir, filename) {
    const fn = safeGlbFilename(filename);
    if (!fn) return false;
    return fs.existsSync(path.join(avatarsDir, fn));
}

export async function listAnimationClipsFromGlbBuffer(buffer) {
    const io = await getGltfTransformIO();
    const u8 = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    const doc = await io.readBinary(u8);
    const clips = doc.getRoot().listAnimations();
    const counts = new Map();
    for (const c of clips) {
        const n = String(c.getName() || '').trim();
        counts.set(n, (counts.get(n) || 0) + 1);
    }
    const seen = new Map();
    return clips.map((c, idx) => {
        const raw = String(c.getName() || '').trim();
        const name = raw || `animation_${idx}`;
        const n = (seen.get(raw) || 0) + 1;
        seen.set(raw, n);
        const duplicated = (counts.get(raw) || 0) > 1;
        const label = duplicated || !raw ? `${name} (#${idx})` : name;
        return { index: idx, name, label };
    });
}

/**
 * アバター表示倍率（1.0＝基準）を安全な範囲に正規化する
 * @param {unknown} v
 * @returns {number}
 */
export function normalizeDisplayScale(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return 1;
    return Math.min(10, Math.max(0.05, n));
}

export function hasCompleteAnimationMap(entry) {
    const clips = Array.isArray(entry?.animationClips) ? entry.animationClips : [];
    if (clips.length === 0) return false;
    const m = entry?.animationMap;
    if (!m || typeof m !== 'object') return false;
    for (const k of AVATAR_REQUIRED_MAP_KEYS) {
        const v = m[k];
        if (typeof v !== 'number' || !Number.isFinite(v)) return false;
        const i = Math.trunc(v);
        if (i < 0 || i >= clips.length) return false;
    }
    return true;
}

export async function ensureAvatarRegistry(avatarsDir) {
    let reg = readAvatarRegistry(avatarsDir);
    if (!reg || !Array.isArray(reg.avatars)) {
        reg = { schemaVersion: 1, registryVersion: 1, avatars: [] };
        const active = readActiveAvatarMeta(avatarsDir);
        const fn = safeGlbFilename(active?.filename || '');
        if (fn && avatarFileExists(avatarsDir, fn)) {
            reg.avatars.push({
                id: crypto.randomUUID(),
                glbFilename: fn,
                isDefault: true,
                animationClips: [],
                animationMap: {},
            });
        }
        writeAvatarRegistry(avatarsDir, reg);
    }
    let changed = false;
    let hasDefault = false;
    for (const a of reg.avatars) {
        a.id = String(a.id || '').trim() || crypto.randomUUID();
        a.glbFilename = safeGlbFilename(a.glbFilename || '');
        if (!a.glbFilename || !avatarFileExists(avatarsDir, a.glbFilename)) continue;
        const rawDs = a.displayScale;
        a.displayScale = normalizeDisplayScale(a.displayScale);
        if (!Number.isFinite(Number(rawDs)) || Number(rawDs) !== a.displayScale) {
            changed = true;
        }
        if (!Array.isArray(a.animationClips) || a.animationClips.length === 0) {
            try {
                const abs = path.join(avatarsDir, a.glbFilename);
                const buf = await fs.promises.readFile(abs);
                a.animationClips = await listAnimationClipsFromGlbBuffer(buf);
                changed = true;
            } catch {
                a.animationClips = [];
            }
        }
        if (a.isDefault && !hasDefault) hasDefault = true;
        else if (a.isDefault && hasDefault) {
            a.isDefault = false;
            changed = true;
        }
    }
    reg.avatars = reg.avatars.filter((a) => a.glbFilename && avatarFileExists(avatarsDir, a.glbFilename));
    if (!hasDefault && reg.avatars.length > 0) {
        reg.avatars[0].isDefault = true;
        changed = true;
    }
    if (changed) {
        reg.registryVersion = Math.trunc(Number(reg.registryVersion) || 0) + 1;
        writeAvatarRegistry(avatarsDir, reg);
    }
    return reg;
}

export function findAvatarById(reg, id) {
    const want = String(id || '').trim();
    if (!want || !Array.isArray(reg?.avatars)) return null;
    return reg.avatars.find((a) => String(a.id) === want) || null;
}

export function resolveAvatarId(reg, avatarsDir, requestedId) {
    const req = String(requestedId || '').trim();
    if (req) {
        const e = findAvatarById(reg, req);
        if (e && hasCompleteAnimationMap(e) && avatarFileExists(avatarsDir, e.glbFilename)) return e.id;
    }
    const d = Array.isArray(reg?.avatars) ? reg.avatars.find((a) => a.isDefault) : null;
    if (d && hasCompleteAnimationMap(d) && avatarFileExists(avatarsDir, d.glbFilename)) return d.id;
    const any = Array.isArray(reg?.avatars) ? reg.avatars.find((a) => hasCompleteAnimationMap(a) && avatarFileExists(avatarsDir, a.glbFilename)) : null;
    return any ? any.id : null;
}

export function bumpRegistryVersion(reg) {
    reg.registryVersion = Math.trunc(Number(reg.registryVersion) || 0) + 1;
}

export async function syncActiveAvatarFromDefault(reg, avatarsDir) {
    const d = Array.isArray(reg?.avatars) ? reg.avatars.find((a) => a.isDefault) : null;
    const fn = safeGlbFilename(d?.glbFilename || '');
    if (!fn || !avatarFileExists(avatarsDir, fn)) return null;
    await setActiveAvatar(avatarsDir, fn);
    return fn;
}
