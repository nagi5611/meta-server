// addons/aircraft/client/runtime-prefab-aircraft-anim.js — 機体ライブラリ定義に基づくローカル表示用アニメ（操縦中）

import * as THREE from 'three';

const TWO_PI = Math.PI * 2;

/**
 * @typedef {{ maxAccelRadPerS2: number, maxOmegaRadPerS: number }} EngineBladeAnimParams
 * @typedef {{ blade: THREE.Object3D, axis: 'x'|'y'|'z', params: EngineBladeAnimParams, state: { omega: number } }} ManualEngineBladeEntry
 * @typedef {{
 *   mixer: THREE.AnimationMixer,
 *   action: THREE.AnimationAction,
 *   baseOmegaRadPerS: number,
 *   maxOmegaRadPerS: number,
 *   maxAccelRadPerS2: number,
 *   state: { omega: number },
 *   blades: THREE.Object3D[],
 * }} EngineBladeGltfDriver
 * @typedef {{ manualBlades: ManualEngineBladeEntry[], gltfDrivers: EngineBladeGltfDriver[] }} EngineBladeLibraryAnim
 * @typedef {{
 *   mixer: THREE.AnimationMixer,
 *   action: THREE.AnimationAction,
 *   clip: THREE.AnimationClip,
 *   direction: -1 | 0 | 1,
 *   absTimeScale: number,
 *   meshes: THREE.Object3D[],
 * }} GearGltfDriver
 * @typedef {{ drivers: GearGltfDriver[] }} GearLibraryAnim
 */

/**
 * @param {THREE.Object3D} obj
 * @returns {string}
 */
function objectDisplayName(obj) {
    return obj.name && obj.name.trim() ? obj.name.trim() : '_unnamed_';
}

/**
 * 同名兄弟がいる場合は `Name#2` 形式で一意化する（管理画面とゲームで同じ規則）
 * @param {THREE.Object3D} obj
 * @param {THREE.Object3D} root
 * @returns {string}
 */
export function objectNamePathFromRoot(obj, root) {
    /** @type {string[]} */
    const parts = [];
    let o = obj;
    while (o && o !== root) {
        const parent = o.parent;
        const base = objectDisplayName(o);
        if (parent) {
            const same = parent.children.filter((c) => objectDisplayName(c) === base);
            if (same.length > 1) {
                const idx = same.indexOf(o);
                parts.unshift(`${base}#${idx + 1}`);
            } else {
                parts.unshift(base);
            }
        } else {
            parts.unshift(base);
        }
        o = parent;
    }
    return parts.join('/');
}

/**
 * @param {THREE.Object3D} parent
 * @param {string} seg
 * @returns {THREE.Object3D[]}
 */
function childrenMatchingSegment(parent, seg) {
    const m = /^(.+)#(\d+)$/.exec(seg);
    const base = m ? m[1] : seg;
    const numbered = m ? Math.max(1, parseInt(m[2], 10)) : 0;
    const matches = parent.children.filter((c) => objectDisplayName(c) === base);
    if (numbered > 0) {
        const pick = matches[numbered - 1];
        return pick ? [pick] : [];
    }
    if (matches.length) return matches;
    return parent.children.filter((c) => objectDisplayName(c) === seg);
}

/**
 * 名前パスで子オブジェクトを取得（管理画面と同じ規則）
 * @param {THREE.Object3D} root
 * @param {string} path
 * @param {Set<string>} [usedUuids] 同一パスを複数割当したとき、未使用の兄弟を選ぶ
 * @returns {THREE.Object3D|null}
 */
export function findObjectByNamePath(root, path, usedUuids) {
    const segments = String(path || '')
        .split('/')
        .filter(Boolean);
    if (!segments.length || !root) return null;
    /** @type {THREE.Object3D} */
    let cur = root;
    for (let i = 0; i < segments.length; i++) {
        const seg = segments[i];
        const isLast = i === segments.length - 1;
        const candidates = childrenMatchingSegment(cur, seg);
        if (!candidates.length) return null;
        if (isLast) {
            let pick = candidates[0];
            if (usedUuids && usedUuids.size > 0) {
                const fresh = candidates.find((c) => !usedUuids.has(c.uuid));
                if (fresh) pick = fresh;
            }
            return pick;
        }
        if (candidates.length !== 1) return null;
        cur = candidates[0];
    }
    return cur;
}

/**
 * バインドパス配列を順に解決し、各エントリごとに別オブジェクトを優先して返す
 * @param {THREE.Object3D} root
 * @param {string[]} paths
 * @returns {THREE.Object3D[]}
 */
export function findObjectsForBindingPaths(root, paths) {
    const used = new Set();
    /** @type {THREE.Object3D[]} */
    const out = [];
    for (const path of paths) {
        const p = String(path || '').trim();
        if (!p) continue;
        const obj = findObjectByNamePath(root, p, used);
        if (!obj) continue;
        used.add(obj.uuid);
        out.push(obj);
    }
    return out;
}

/**
 * 機体ライブラリの engineBlade アニメ JSON を正規化する
 * @param {unknown} eb
 * @returns {{ axis: 'x'|'y'|'z', params: EngineBladeAnimParams, clipName: string }}
 */
export function parseEngineBladeAnimationConfig(eb) {
    const ax = String(eb && typeof eb === 'object' && !Array.isArray(eb) ? eb.spinAxis : 'z').toLowerCase();
    const axis = ax === 'x' || ax === 'y' || ax === 'z' ? ax : 'z';
    const o = eb && typeof eb === 'object' && !Array.isArray(eb) ? eb : {};
    const params = {
        maxAccelRadPerS2: typeof o.maxAccelRadPerS2 === 'number' ? o.maxAccelRadPerS2 : 24,
        maxOmegaRadPerS: typeof o.maxOmegaRadPerS === 'number' ? o.maxOmegaRadPerS : 140,
    };
    const clipName = typeof o.clipName === 'string' ? o.clipName.trim() : '';
    return { axis, params, clipName };
}

/**
 * gltfClips を保持する prefab パーツ root を祖先方向に探す
 * @param {THREE.Object3D} obj
 * @param {THREE.Object3D} stopAt
 * @returns {THREE.Object3D|null}
 */
export function findGltfClipsHostAncestor(obj, stopAt) {
    let o = obj;
    while (o && o !== stopAt) {
        const clips = o.userData?.gltfClips;
        if (Array.isArray(clips) && clips.length) return o;
        o = o.parent;
    }
    return null;
}

/**
 * @param {THREE.AnimationClip[]} clips
 * @param {string} clipName
 * @returns {THREE.AnimationClip|null}
 */
export function findGltfClipByName(clips, clipName) {
    const cn = String(clipName || '').trim();
    if (!cn || !Array.isArray(clips)) return null;
    return clips.find((c) => c && c.name === cn) || null;
}

/**
 * 360° 1 回転クリップの timeScale=1 相当角速度 (rad/s)
 * @param {THREE.AnimationClip} clip
 * @returns {number}
 */
export function engineBladeClipBaseOmegaRadPerS(clip) {
    const d = clip?.duration;
    if (typeof d !== 'number' || !Number.isFinite(d) || d <= 0) return 0;
    return TWO_PI / d;
}

/**
 * engineBlade バインドと定義から GLB クリップ駆動／手動回転の状態を構築する
 * clipName 指定かつクリップ解決できたブレードは GLB、それ以外は手動フォールバック
 * @param {THREE.Object3D} root
 * @param {string[]} paths
 * @param {unknown} eb animation.engineBlade
 * @returns {EngineBladeLibraryAnim}
 */
export function buildEngineBladeLibraryAnim(root, paths, eb) {
    const { axis, params, clipName } = parseEngineBladeAnimationConfig(eb);
    const resolvedBlades = findObjectsForBindingPaths(root, paths);

    /** @type {Map<string, { host: THREE.Object3D, clip: THREE.AnimationClip, blades: THREE.Object3D[] }>} */
    const gltfGroups = new Map();
    /** @type {ManualEngineBladeEntry[]} */
    const manualBlades = [];

    for (const blade of resolvedBlades) {
        if (clipName) {
            const host = findGltfClipsHostAncestor(blade, root);
            const clips = host?.userData?.gltfClips;
            const clip = clips ? findGltfClipByName(clips, clipName) : null;
            const baseOmega = clip ? engineBladeClipBaseOmegaRadPerS(clip) : 0;
            if (host && clip && baseOmega > 0) {
                const key = `${host.uuid}:${clip.uuid}`;
                let g = gltfGroups.get(key);
                if (!g) {
                    g = { host, clip, blades: [] };
                    gltfGroups.set(key, g);
                }
                g.blades.push(blade);
                continue;
            }
        }
        manualBlades.push({ blade, axis, params, state: { omega: 0 } });
    }

    /** @type {EngineBladeGltfDriver[]} */
    const gltfDrivers = [];
    for (const g of gltfGroups.values()) {
        const mixer = new THREE.AnimationMixer(g.host);
        const action = mixer.clipAction(g.clip);
        action.setLoop(THREE.LoopRepeat, Infinity);
        action.play();
        gltfDrivers.push({
            mixer,
            action,
            baseOmegaRadPerS: engineBladeClipBaseOmegaRadPerS(g.clip),
            maxOmegaRadPerS: params.maxOmegaRadPerS,
            maxAccelRadPerS2: params.maxAccelRadPerS2,
            state: { omega: 0 },
            blades: g.blades,
        });
    }

    return { manualBlades, gltfDrivers };
}

/**
 * GLB 駆動ミキサーを解放する
 * @param {EngineBladeGltfDriver[]|null|undefined} drivers
 * @returns {void}
 */
export function disposeEngineBladeGltfDrivers(drivers) {
    if (!drivers?.length) return;
    for (const d of drivers) {
        d.action?.stop();
        d.mixer?.stopAllAction();
    }
}

/**
 * @param {EngineBladeGltfDriver} driver
 * @param {number} targetOmegaRadPerS
 * @param {number} maxAccelRadPerS2
 * @param {number} dt
 * @returns {void}
 */
function stepEngineBladeGltfDriverToTargetOmega(driver, targetOmegaRadPerS, maxAccelRadPerS2, dt) {
    const maxA = Math.max(0.01, Number(maxAccelRadPerS2) || 24);
    const target = Math.max(0, Number(targetOmegaRadPerS) || 0);
    let w = driver.state.omega;
    const diff = target - w;
    w += Math.sign(diff) * Math.min(Math.abs(diff), maxA * dt);
    driver.state.omega = w;
    const base = driver.baseOmegaRadPerS;
    driver.action.timeScale = base > 0 ? w / base : 0;
    driver.mixer.update(dt);
}

/**
 * Hard 操縦: 推力相当 0..1 からエンジンブレードを更新（GLB クリップ優先・手動フォールバック）
 * @param {EngineBladeLibraryAnim|null|undefined} libAnim
 * @param {number} throttle01
 * @param {number} dt
 * @returns {void}
 */
export function stepEngineBladeLibraryAnimHard(libAnim, throttle01, dt) {
    if (!libAnim || dt <= 0) return;
    const t01 = THREE.MathUtils.clamp(throttle01, 0, 1);
    for (const b of libAnim.manualBlades) {
        stepEngineBladeRotation(b.blade, b.axis, b.params, t01, dt, b.state);
    }
    for (const d of libAnim.gltfDrivers) {
        const target = t01 * Math.max(0, Number(d.maxOmegaRadPerS) || 0);
        stepEngineBladeGltfDriverToTargetOmega(d, target, d.maxAccelRadPerS2, dt);
    }
}

/**
 * Easy 操縦: 目標角速度 (rad/s) からエンジンブレードを更新
 * @param {EngineBladeLibraryAnim|null|undefined} libAnim
 * @param {number} targetOmegaRadPerS
 * @param {number} maxAccelRadPerS2
 * @param {number} dt
 * @returns {void}
 */
export function stepEngineBladeLibraryAnimEasy(libAnim, targetOmegaRadPerS, maxAccelRadPerS2, dt) {
    if (!libAnim || dt <= 0) return;
    for (const b of libAnim.manualBlades) {
        stepEngineBladeRotationToTargetOmega(b.blade, b.axis, targetOmegaRadPerS, maxAccelRadPerS2, dt, b.state);
    }
    for (const d of libAnim.gltfDrivers) {
        stepEngineBladeGltfDriverToTargetOmega(d, targetOmegaRadPerS, maxAccelRadPerS2, dt);
    }
}

/**
 * 管理画面プレビュー: 固定角速度で即時追従
 * @param {EngineBladeLibraryAnim|null|undefined} libAnim
 * @param {number} omegaRadPerS
 * @param {number} dt
 * @returns {void}
 */
export function stepEngineBladeLibraryAnimPreview(libAnim, omegaRadPerS, dt) {
    if (!libAnim || dt <= 0) return;
    const w = Math.max(0, Number(omegaRadPerS) || 0);
    for (const b of libAnim.manualBlades) {
        b.state.omega = w;
        if (b.axis === 'x') b.blade.rotation.x += w * dt;
        else if (b.axis === 'y') b.blade.rotation.y += w * dt;
        else b.blade.rotation.z += w * dt;
    }
    for (const d of libAnim.gltfDrivers) {
        d.state.omega = w;
        const base = d.baseOmegaRadPerS;
        d.action.timeScale = base > 0 ? w / base : 0;
        d.mixer.update(dt);
    }
}

/**
 * @param {EngineBladeLibraryAnim|null|undefined} libAnim
 * @returns {boolean}
 */
export function hasEngineBladeLibraryAnim(libAnim) {
    if (!libAnim) return false;
    return (libAnim.manualBlades?.length ?? 0) > 0 || (libAnim.gltfDrivers?.length ?? 0) > 0;
}

const GEAR_TIME_EPS = 1e-4;

/**
 * @param {unknown} g animation.gear
 * @returns {{ clipName: string, playbackFps: number, sourceFps: number, absTimeScale: number }}
 */
export function parseGearAnimationConfig(g) {
    const o = g && typeof g === 'object' && !Array.isArray(g) ? g : {};
    const clipName = typeof o.clipName === 'string' ? o.clipName.trim() : '';
    const playbackFps = typeof o.playbackFps === 'number' && Number.isFinite(o.playbackFps) && o.playbackFps > 0
        ? o.playbackFps
        : 24;
    const sourceFps = typeof o.sourceFps === 'number' && Number.isFinite(o.sourceFps) && o.sourceFps > 0
        ? o.sourceFps
        : 24;
    return { clipName, playbackFps, sourceFps, absTimeScale: playbackFps / sourceFps };
}

/**
 * gear ロール割当と GLB クリップから着陸装置アニメ状態を構築（初期: 展開 t=0 で停止）
 * @param {THREE.Object3D} root
 * @param {string[]} paths
 * @param {unknown} gearConfig animation.gear
 * @returns {GearLibraryAnim|null}
 */
export function buildGearLibraryAnim(root, paths, gearConfig) {
    const { clipName, absTimeScale } = parseGearAnimationConfig(gearConfig);
    if (!clipName || !paths.length || !root) return null;

    /** @type {Map<string, { host: THREE.Object3D, clip: THREE.AnimationClip, meshes: THREE.Object3D[] }>} */
    const groups = new Map();
    for (const path of paths) {
        const p = String(path || '').trim();
        if (!p) continue;
        const mesh = findObjectByNamePath(root, p);
        if (!mesh) continue;
        const host = findGltfClipsHostAncestor(mesh, root);
        const clips = host?.userData?.gltfClips;
        const clip = clips ? findGltfClipByName(clips, clipName) : null;
        if (!host || !clip || !(clip.duration > 0)) continue;
        const key = `${host.uuid}:${clip.uuid}`;
        let g = groups.get(key);
        if (!g) {
            g = { host, clip, meshes: [] };
            groups.set(key, g);
        }
        g.meshes.push(mesh);
    }
    if (!groups.size) return null;

    /** @type {GearGltfDriver[]} */
    const drivers = [];
    for (const g of groups.values()) {
        const mixer = new THREE.AnimationMixer(g.host);
        const action = mixer.clipAction(g.clip);
        action.setLoop(THREE.LoopOnce, 1);
        action.clampWhenFinished = true;
        action.time = 0;
        action.timeScale = 0;
        action.play();
        action.paused = true;
        drivers.push({
            mixer,
            action,
            clip: g.clip,
            direction: 0,
            absTimeScale,
            meshes: g.meshes,
        });
    }
    return drivers.length ? { drivers } : null;
}

/**
 * @param {GearLibraryAnim|null|undefined} gearAnim
 * @returns {boolean}
 */
export function hasGearLibraryAnim(gearAnim) {
    return (gearAnim?.drivers?.length ?? 0) > 0;
}

/**
 * @param {GearGltfDriver[]} drivers
 * @returns {void}
 */
export function disposeGearGltfDrivers(drivers) {
    if (!drivers?.length) return;
    for (const d of drivers) {
        d.action?.stop();
        d.mixer?.stopAllAction();
    }
}

/**
 * G キー相当: 再生方向を反転（停止中は位置に応じて収納/展開へ）
 * @param {GearLibraryAnim|null|undefined} gearAnim
 * @returns {void}
 */
export function toggleGearAnimationDirection(gearAnim) {
    if (!gearAnim?.drivers?.length) return;
    for (const d of gearAnim.drivers) {
        const dur = d.clip.duration;
        const t = d.action.time;
        let dir = d.direction;
        if (dir === 0) {
            dir = t >= dur - GEAR_TIME_EPS ? -1 : 1;
        } else {
            dir = /** @type {-1|1} */ (dir * -1);
        }
        d.direction = dir;
        d.action.paused = false;
        d.action.enabled = true;
        if (dir < 0 && t >= dur - GEAR_TIME_EPS) {
            d.action.time = dur;
        }
        if (dir > 0 && t <= GEAR_TIME_EPS) {
            d.action.time = 0;
        }
        d.action.timeScale = dir * d.absTimeScale;
    }
}

/**
 * 着陸装置クリップを進め、端で停止してフレームを保持する
 * @param {GearLibraryAnim|null|undefined} gearAnim
 * @param {number} dt
 * @returns {void}
 */
export function stepGearLibraryAnim(gearAnim, dt) {
    if (!gearAnim?.drivers?.length || dt <= 0) return;
    for (const d of gearAnim.drivers) {
        if (d.direction === 0) continue;
        d.mixer.update(dt);
        const dur = d.clip.duration;
        const t = d.action.time;
        if (d.direction > 0 && t >= dur - GEAR_TIME_EPS) {
            d.action.time = dur;
            d.action.timeScale = 0;
            d.action.paused = true;
            d.direction = 0;
        } else if (d.direction < 0 && t <= GEAR_TIME_EPS) {
            d.action.time = 0;
            d.action.timeScale = 0;
            d.action.paused = true;
            d.direction = 0;
        }
    }
}

/**
 * エンジンブレードの目標角速度へ角加速度制限付きで追従し、ローカル回転を積む。
 * v1.1 はネット同期しない（各クライアントが同じ定義と機体姿勢から再現）。
 * @param {THREE.Object3D} blade
 * @param {'x'|'y'|'z'} axis
 * @param {{ maxAccelRadPerS2: number, maxOmegaRadPerS: number }} params
 * @param {number} throttle01 0..1
 * @param {number} dt
 * @param {{ omega: number }} state
 */
export function stepEngineBladeRotation(blade, axis, params, throttle01, dt, state) {
    const maxA = Math.max(0.01, Number(params.maxAccelRadPerS2) || 24);
    const maxW = Math.max(0, Number(params.maxOmegaRadPerS) || 140);
    const target = THREE.MathUtils.clamp(throttle01, 0, 1) * maxW;
    stepEngineBladeRotationToTargetOmega(blade, axis, target, maxA, dt, state);
}

/**
 * 目標角速度 (rad/s) へ角加速度制限付きで追従し、ローカル回転を積む。
 * @param {THREE.Object3D} blade
 * @param {'x'|'y'|'z'} axis
 * @param {number} targetOmegaRadPerS
 * @param {number} maxAccelRadPerS2
 * @param {number} dt
 * @param {{ omega: number }} state
 */
export function stepEngineBladeRotationToTargetOmega(blade, axis, targetOmegaRadPerS, maxAccelRadPerS2, dt, state) {
    const maxA = Math.max(0.01, Number(maxAccelRadPerS2) || 5);
    const target = Math.max(0, Number(targetOmegaRadPerS) || 0);
    let w = state.omega;
    const diff = target - w;
    const step = Math.sign(diff) * Math.min(Math.abs(diff), maxA * dt);
    w += step;
    state.omega = w;
    if (axis === 'x') blade.rotation.x += w * dt;
    else if (axis === 'y') blade.rotation.y += w * dt;
    else blade.rotation.z += w * dt;
}

/**
 * フラップメッシュのローカル軸角度を目標へ角速度上限付きで追従する（操縦中ローカル表示用）
 * @param {THREE.Object3D} mesh
 * @param {'x'|'y'|'z'} axis
 * @param {number} targetRad
 * @param {number} maxOmegaRadPerS
 * @param {number} dt
 * @param {{ angle: number }} state — mesh の当該軸上の累積角と同期（初回は mesh から読む想定）
 */
export function stepFlapDeflection(mesh, axis, targetRad, maxOmegaRadPerS, dt, state) {
    const maxW = Math.max(0.01, Number(maxOmegaRadPerS) || 0.8);
    let cur = state.angle;
    if (!Number.isFinite(cur)) {
        if (axis === 'x') cur = mesh.rotation.x;
        else if (axis === 'y') cur = mesh.rotation.y;
        else cur = mesh.rotation.z;
        state.angle = cur;
    }
    const diff = targetRad - cur;
    const step = Math.sign(diff) * Math.min(Math.abs(diff), maxW * dt);
    cur += step;
    state.angle = cur;
    if (axis === 'x') mesh.rotation.x = cur;
    else if (axis === 'y') mesh.rotation.y = cur;
    else mesh.rotation.z = cur;
}
