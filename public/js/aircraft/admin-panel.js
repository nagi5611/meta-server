// public/js/aircraft/admin-panel.js — 飛行機ライブラリ管理 UI（/js 配信・Nginx では /addons を経由しない）

import {
    AIRFRAME_ROLE_KEYS,
    defaultAnimationJson,
    normalizeBindings,
    bindingPathsForRole,
} from './airframe-definition-schema.js';
import { AdminAircraftPrefabViewer, collectNamePaths } from './admin-prefab-viewer.js';
import {
    mountFlightPhysicsForm,
    fillFlightPhysicsForm,
    readFlightPhysicsFromForm,
} from './flight-physics-admin-form.js';
import {
    mountEasyFlightPhysicsForm,
    fillEasyFlightPhysicsForm,
    readEasyFlightPhysicsFromForm,
} from './flight-physics-easy-admin-form.js';
import { normalizeAircraftControlMode } from '../../../addons/aircraft/client/aircraft-physics-easy-defaults.js';
import { migrateLegacyCameraToViewpoints, buildCameraJsonForPut } from './camera-viewpoints.js';
import { applyMeshVisualEulerDegToModel, normalizeMeshVisualEulerDeg } from './mesh-visual-pivot.js';

let mounted = false;
/** @type {AdminAircraftPrefabViewer|null} */
let viewer = null;
/** @type {string|null} */
let selectedAirframeId = null;
/** @type {object|null} */
let draftAirframe = null;
/** @type {string|null} */
let selectedViewpointId = null;
/** @type {'object'|'params'|'branch'} */
let activeRightTab = 'object';
/** @type {'hard'|'easy'} */
let activePhysicsProfile = 'hard';
/** @type {'hard'|'easy'} */
let activeViewpointProfile = 'hard';
/** @type {((e: KeyboardEvent) => void) | null} */
let acVpKeydownHandler = null;

/**
 * @param {string} url
 * @param {object} [opt]
 * @returns {Promise<object>}
 */
async function fetchJson(url, opt = {}) {
    const res = await fetch(url, { credentials: 'include', ...opt });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(j.error || res.statusText || 'request_failed');
    return j;
}

/**
 * @param {File} file
 * @param {string} endpoint 例 `/admin/upload-plane-prefab-zip`
 * @returns {Promise<{ prefabManifest: string }>}
 */
async function uploadPrefabZip(file, endpoint) {
    const postZip = (confirmFlag) =>
        new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            xhr.open('POST', `${endpoint}${confirmFlag ? '?confirm=1' : ''}`);
            xhr.withCredentials = true;
            xhr.addEventListener('load', () => {
                let json = null;
                try {
                    json = xhr.responseText ? JSON.parse(xhr.responseText) : null;
                } catch {
                    json = null;
                }
                resolve({ status: xhr.status, json });
            });
            xhr.addEventListener('error', () => reject(new Error('network')));
            const form = new FormData();
            form.append('zip', file, file.name);
            xhr.send(form);
        });

    let r = await postZip(false);
    if (r.status === 409 && r.json && Array.isArray(r.json.conflictingFiles)) {
        const names = r.json.conflictingFiles;
        const head = names.slice(0, 25).join('\n');
        const more = names.length > 25 ? `\n…他 ${names.length - 25} 件` : '';
        if (!window.confirm(`次のファイルが既に存在します。上書きしますか？\n\n${head}${more}`)) {
            throw new Error('cancelled');
        }
        r = await postZip(true);
    }
    if (r.status !== 200 || !r.json || !r.json.success) {
        throw new Error(r.json?.error || `HTTP ${r.status}`);
    }
    return r.json;
}

/**
 * `plane/` 配下のマニフェスト一覧でセレクトを再構築する
 * @returns {Promise<void>}
 */
async function reloadPlaneManifestSelect() {
    const sel = /** @type {HTMLSelectElement|null} */ (document.getElementById('ac-manifest-select'));
    if (!sel) return;
    /** @type {string[]} */
    let names = [];
    try {
        const res = await fetch('/admin/plane-prefab-manifests', { credentials: 'include' });
        const j = await res.json().catch(() => []);
        names = Array.isArray(j) ? j : [];
    } catch {
        names = [];
    }
    const cur = String(draftAirframe?.prefabManifest || document.getElementById('ac-field-manifest')?.value || '').trim();
    sel.innerHTML = '<option value="">（プレハブを選択）</option>';
    if (cur && !names.some((n) => `plane/${n}` === cur)) {
        const opt = document.createElement('option');
        opt.value = cur;
        opt.textContent = cur.startsWith('models/') ? `(互換 models) ${cur}` : cur;
        sel.appendChild(opt);
    }
    for (const n of names) {
        const val = `plane/${n}`;
        const opt = document.createElement('option');
        opt.value = val;
        opt.textContent = n;
        sel.appendChild(opt);
    }
    if (cur && [...sel.options].some((o) => o.value === cur)) {
        sel.value = cur;
    } else {
        sel.value = '';
    }
}

/**
 * @returns {void}
 */
function setStatus(msg, isErr = false) {
    const el = document.getElementById('ac-admin-status');
    if (!el) return;
    el.textContent = msg;
    el.classList.toggle('error', isErr);
    el.classList.toggle('success', !isErr && !!msg);
}

/**
 * @returns {Promise<void>}
 */
async function reloadList() {
    const data = await fetchJson('/admin/addons/aircraft/airframes');
    const list = document.getElementById('ac-airframe-list');
    if (!list) return;
    list.innerHTML = '';
    const items = data.airframes || [];
    for (const a of items) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = `ac-airframe-item${selectedAirframeId === a.id ? ' selected' : ''}`;
        const modeTag = normalizeAircraftControlMode(a.controlMode) === 'easy' ? 'EASY' : 'HARD';
        btn.textContent = `${a.id} — ${a.displayName || '(無名)'} [${modeTag}]`;
        btn.dataset.id = a.id;
        btn.addEventListener('click', () => {
            void selectAirframe(a.id);
        });
        list.appendChild(btn);
    }
    if (!items.length) {
        const p = document.createElement('p');
        p.className = 'hint';
        p.textContent = '機体がありません。「機体を追加」で作成してください。';
        list.appendChild(p);
    }
}

/**
 * 右パネル「メッシュ見た目」の数値を読む（度）
 * @returns {{ x: number, y: number, z: number }}
 */
function readMeshVisualEulerFromForm() {
    const p = (id) => {
        const el = document.getElementById(id);
        const n = el && 'value' in el ? parseFloat(/** @type {HTMLInputElement} */ (el).value) : NaN;
        return Number.isFinite(n) ? n : 0;
    };
    return { x: p('ac-mesh-rx'), y: p('ac-mesh-ry'), z: p('ac-mesh-rz') };
}

/**
 * プレハブルートにメッシュ見た目ピボットを適用（ビューアプレビュー）
 * @returns {void}
 */
function applyMeshVisualPivotToViewer() {
    const root = viewer?.getPrefabRoot?.();
    if (!root) return;
    applyMeshVisualEulerDegToModel(root, readMeshVisualEulerFromForm());
}

/**
 * @returns {void}
 */
function syncFormFromDraft() {
    const d = draftAirframe;
    const setVal = (id, v) => {
        const el = document.getElementById(id);
        if (el && 'value' in el) /** @type {HTMLInputElement} */ (el).value = v;
    };
    setVal('ac-field-id', d?.id || '');
    setVal('ac-field-display', d?.displayName || '');
    setVal('ac-field-manifest', d?.prefabManifest || '');
    const anim = (d?.animation && typeof d.animation === 'object' ? d.animation : {}) || {};
    const eb = anim.engineBlade && typeof anim.engineBlade === 'object' ? anim.engineBlade : {};
    setVal('ac-anim-maxaccel', String(typeof eb.maxAccelRadPerS2 === 'number' ? eb.maxAccelRadPerS2 : 24));
    setVal('ac-anim-maxomega', String(typeof eb.maxOmegaRadPerS === 'number' ? eb.maxOmegaRadPerS : 140));
    const spin = typeof eb.spinAxis === 'string' && eb.spinAxis ? eb.spinAxis : 'z';
    const spinEl = document.getElementById('ac-anim-spinaxis');
    if (spinEl && 'value' in spinEl) /** @type {HTMLSelectElement} */ (spinEl).value = spin;
    const roleSel = /** @type {HTMLSelectElement|null} */ (document.getElementById('ac-role-select'));
    if (roleSel) {
        roleSel.innerHTML = '';
        for (const role of AIRFRAME_ROLE_KEYS) {
            const opt = document.createElement('option');
            opt.value = role;
            opt.textContent = role;
            roleSel.appendChild(opt);
        }
    }
    const pathSel = /** @type {HTMLSelectElement|null} */ (document.getElementById('ac-path-select'));
    if (pathSel && !viewer?.getPrefabRoot?.()) {
        pathSel.innerHTML = '<option value="">（プレハブ読込後に一覧表示）</option>';
    }
    const bindList = document.getElementById('ac-bindings-list');
    if (bindList) {
        bindList.innerHTML = '';
        const bind = d?.bindings && typeof d.bindings === 'object' ? d.bindings : {};
        let any = false;
        for (const role of AIRFRAME_ROLE_KEYS) {
            const paths = bindingPathsForRole(bind, role);
            if (!paths.length) continue;
            any = true;
            const sec = document.createElement('div');
            sec.className = 'ac-binding-role-block';
            const h = document.createElement('div');
            h.className = 'ac-binding-role-title';
            h.textContent = role;
            sec.appendChild(h);
            for (const p of paths) {
                const row = document.createElement('div');
                row.className = 'ac-binding-row';
                const code = document.createElement('code');
                code.textContent = p;
                row.appendChild(code);
                const del = document.createElement('button');
                del.type = 'button';
                del.className = 'btn btn-sm btn-outline-secondary';
                del.textContent = '削除';
                del.dataset.role = role;
                del.dataset.path = p;
                del.addEventListener('click', () => {
                    if (!draftAirframe) return;
                    const cur = bindingPathsForRole(draftAirframe.bindings, role).filter((x) => x !== p);
                    const b = { ...(draftAirframe.bindings || {}) };
                    if (cur.length) b[role] = cur;
                    else delete b[role];
                    draftAirframe.bindings = normalizeBindings(b);
                    syncFormFromDraft();
                    setStatus(`削除: ${role} の「${p}」`);
                });
                row.appendChild(del);
                sec.appendChild(row);
            }
            bindList.appendChild(sec);
        }
        if (!any) {
            bindList.innerHTML = '<p class="hint">未割当です。ロールを選びパスを指定して「追加」してください。</p>';
        }
    }
    const delBtn = document.getElementById('ac-btn-delete');
    if (delBtn) delBtn.disabled = !d?.id;
    const cm = normalizeAircraftControlMode(d?.controlMode);
    document.querySelectorAll('input[name="ac-control-mode"]').forEach((el) => {
        if (el instanceof HTMLInputElement) el.checked = el.value === cm;
    });
    fillFlightPhysicsForm(d?.flightPhysicsHard ?? d?.flightPhysics);
    fillEasyFlightPhysicsForm(d?.flightPhysicsEasy);
    const camMesh =
        d?.cameraHard && typeof d.cameraHard === 'object'
            ? d.cameraHard
            : d?.camera && typeof d.camera === 'object'
              ? d.camera
              : {};
    const me = normalizeMeshVisualEulerDeg(camMesh.meshVisualEulerDeg);
    setVal('ac-mesh-rx', String(me.x));
    setVal('ac-mesh-ry', String(me.y));
    setVal('ac-mesh-rz', String(me.z));
    syncViewpointPanelFromDraft();
    refreshRightTabVisibility();
    applyMeshVisualPivotToViewer();
}

/**
 * @returns {'hard'|'easy'}
 */
function readControlModeFromForm() {
    const el = /** @type {HTMLInputElement|null} */ (
        document.querySelector('input[name="ac-control-mode"]:checked')
    );
    return normalizeAircraftControlMode(el?.value);
}

/**
 * @param {'hard'|'easy'} profile
 * @returns {Record<string, unknown>}
 */
function getDraftCameraBucket(profile) {
    if (!draftAirframe) return {};
    const key = profile === 'easy' ? 'cameraEasy' : 'cameraHard';
    const cur = draftAirframe[key];
    if (cur && typeof cur === 'object' && !Array.isArray(cur)) return /** @type {Record<string, unknown>} */ (cur);
    if (profile === 'hard' && draftAirframe.camera && typeof draftAirframe.camera === 'object') {
        return /** @type {Record<string, unknown>} */ (draftAirframe.camera);
    }
    draftAirframe[key] = {};
    return /** @type {Record<string, unknown>} */ (draftAirframe[key]);
}

/**
 * @returns {ReturnType<typeof migrateLegacyCameraToViewpoints>}
 */
function getViewpointsList() {
    return migrateLegacyCameraToViewpoints(getDraftCameraBucket(activeViewpointProfile));
}

/**
 * @param {ReturnType<typeof migrateLegacyCameraToViewpoints>} vps
 * @returns {void}
 */
function applyViewpointsToDraftCamera(vps) {
    if (!draftAirframe) return;
    const key = activeViewpointProfile === 'easy' ? 'cameraEasy' : 'cameraHard';
    draftAirframe[key] = buildCameraJsonForPut(getDraftCameraBucket(activeViewpointProfile), vps);
}

/**
 * @param {'hard'|'easy'} profile
 * @returns {void}
 */
function setActivePhysicsProfile(profile) {
    activePhysicsProfile = profile === 'easy' ? 'easy' : 'hard';
    document.querySelectorAll('[data-ac-physics-profile]').forEach((btn) => {
        const t = /** @type {HTMLElement} */ (btn).dataset.acPhysicsProfile;
        btn.classList.toggle('is-active', t === activePhysicsProfile);
    });
    const hardPane = document.getElementById('ac-physics-pane-hard');
    const easyPane = document.getElementById('ac-physics-pane-easy');
    if (hardPane) hardPane.style.display = activePhysicsProfile === 'hard' ? '' : 'none';
    if (easyPane) easyPane.style.display = activePhysicsProfile === 'easy' ? '' : 'none';
}

/**
 * @param {'hard'|'easy'} profile
 * @returns {void}
 */
function setActiveViewpointProfile(profile) {
    readViewpointDetailIntoDraft();
    activeViewpointProfile = profile === 'easy' ? 'easy' : 'hard';
    document.querySelectorAll('[data-ac-vp-profile]').forEach((btn) => {
        const t = /** @type {HTMLElement} */ (btn).dataset.acVpProfile;
        btn.classList.toggle('is-active', t === activeViewpointProfile);
    });
    syncViewpointPanelFromDraft();
}

/**
 * @returns {void}
 */
function syncViewpointPanelFromDraft() {
    const sel = /** @type {HTMLSelectElement|null} */ (document.getElementById('ac-vp-select'));
    if (!sel) return;
    const vps = getViewpointsList();
    const keep = selectedViewpointId;
    sel.innerHTML = '';
    for (const vp of vps) {
        const opt = document.createElement('option');
        opt.value = vp.id;
        opt.textContent = `${vp.name || vp.id} (${vp.role})`;
        sel.appendChild(opt);
    }
    if (keep && vps.some((v) => v.id === keep)) selectedViewpointId = keep;
    else selectedViewpointId = vps[0]?.id || null;
    if (selectedViewpointId && [...sel.options].some((o) => o.value === selectedViewpointId)) {
        sel.value = selectedViewpointId;
    } else if (sel.options.length) {
        sel.selectedIndex = 0;
        selectedViewpointId = sel.value;
    } else {
        selectedViewpointId = null;
    }
    fillViewpointDetailInputs();
    syncViewpointEditorOnViewer();
}

/**
 * @returns {void}
 */
function fillViewpointDetailInputs() {
    const vp = getViewpointsList().find((v) => v.id === selectedViewpointId);
    const set = (id, v) => {
        const el = document.getElementById(id);
        if (el && 'value' in el) /** @type {HTMLInputElement} */ (el).value = String(v);
    };
    const setSel = (id, v) => {
        const el = document.getElementById(id);
        if (el && 'value' in el) /** @type {HTMLSelectElement} */ (el).value = v;
    };
    if (!vp) {
        set('ac-vp-name', '');
        setSel('ac-vp-role', 'free');
        for (const k of ['ac-vp-px', 'ac-vp-py', 'ac-vp-pz', 'ac-vp-rx', 'ac-vp-ry', 'ac-vp-rz']) set(k, '0');
        return;
    }
    set('ac-vp-name', vp.name || vp.id);
    setSel('ac-vp-role', vp.role === 'cockpit' || vp.role === 'chase' ? vp.role : 'free');
    set('ac-vp-px', vp.position.x);
    set('ac-vp-py', vp.position.y);
    set('ac-vp-pz', vp.position.z);
    const e = vp.eulerDeg || { x: 0, y: 0, z: 0 };
    set('ac-vp-rx', e.x ?? 0);
    set('ac-vp-ry', e.y ?? 0);
    set('ac-vp-rz', e.z ?? 0);
}

/**
 * @returns {void}
 */
function readViewpointDetailIntoDraft() {
    const vps = getViewpointsList();
    const idx = vps.findIndex((v) => v.id === selectedViewpointId);
    if (idx < 0) return;
    const p = (id) => {
        const el = document.getElementById(id);
        const n = el && 'value' in el ? parseFloat(/** @type {HTMLInputElement} */ (el).value) : NaN;
        return Number.isFinite(n) ? n : 0;
    };
    const name = String(document.getElementById('ac-vp-name')?.value || '').trim();
    const roleEl = /** @type {HTMLSelectElement|null} */ (document.getElementById('ac-vp-role'));
    const roleRaw = roleEl?.value || 'free';
    const role = roleRaw === 'cockpit' || roleRaw === 'chase' ? roleRaw : 'free';
    vps[idx] = {
        ...vps[idx],
        name: name || vps[idx].id,
        role,
        position: { x: p('ac-vp-px'), y: p('ac-vp-py'), z: p('ac-vp-pz') },
        eulerDeg: { x: p('ac-vp-rx'), y: p('ac-vp-ry'), z: p('ac-vp-rz') },
    };
    applyViewpointsToDraftCamera(vps);
    viewer?.refreshViewpointMarkersFrom(getViewpointsList());
}

/**
 * @returns {void}
 */
function syncViewpointEditorOnViewer() {
    if (!viewer) return;
    if (activeRightTab !== 'branch') {
        viewer.setViewpointEditMode({
            active: false,
            viewpoints: [],
            selectedId: null,
            onUpdate: null,
            onSelectRequest: null,
        });
        return;
    }
    const vps = getViewpointsList();
    viewer.setViewpointEditMode({
        active: true,
        blockPrefabPick: true,
        viewpoints: vps,
        selectedId: selectedViewpointId,
        onUpdate: (markersPayload) => {
            const base = getViewpointsList();
            for (let i = 0; i < base.length; i++) {
                const u = markersPayload.find((m) => m.id === base[i].id);
                if (u) {
                    base[i] = {
                        ...base[i],
                        position: { ...u.position },
                        eulerDeg: { ...u.eulerDeg },
                    };
                }
            }
            applyViewpointsToDraftCamera(base);
            fillViewpointDetailInputs();
        },
        onSelectRequest: (id) => {
            selectedViewpointId = id;
            const sel = document.getElementById('ac-vp-select');
            if (sel && 'value' in sel) /** @type {HTMLSelectElement} */ (sel).value = id;
            viewer?.setSelectedViewpointId(id, getViewpointsList());
            fillViewpointDetailInputs();
        },
    });
}

/**
 * @returns {void}
 */
function refreshRightTabVisibility() {
    const panes = {
        object: document.getElementById('ac-pane-object'),
        params: document.getElementById('ac-pane-params'),
        branch: document.getElementById('ac-pane-branch'),
    };
    for (const [k, el] of Object.entries(panes)) {
        if (!el) continue;
        el.style.display = k === activeRightTab ? '' : 'none';
    }
    document.querySelectorAll('.ac-tab-btn').forEach((btn) => {
        const t = /** @type {HTMLElement} */ (btn).dataset.acTab;
        btn.classList.toggle('is-active', t === activeRightTab);
    });
    const hint = document.getElementById('ac-viewer-hint');
    if (hint) {
        if (activeRightTab === 'branch') {
            hint.textContent =
                '視点マーカーをドラッグ（矢印／回転）または右の数値・矢印キーで編集。マーカーをクリックで視点を選択。';
        } else {
            hint.textContent = 'クリックでオブジェクト選択（ハイライト）';
        }
    }
    syncViewpointEditorOnViewer();
}

/**
 * @param {'object'|'params'|'branch'} tab
 * @returns {void}
 */
function setActiveRightTab(tab) {
    activeRightTab = tab;
    refreshRightTabVisibility();
}

/**
 * @returns {object}
 */
function readAnimationFromForm() {
    const maxAccel = parseFloat(String(document.getElementById('ac-anim-maxaccel')?.value || '24'));
    const maxOmega = parseFloat(String(document.getElementById('ac-anim-maxomega')?.value || '140'));
    const spinAxis = String(document.getElementById('ac-anim-spinaxis')?.value || 'z').toLowerCase();
    const axis = ['x', 'y', 'z'].includes(spinAxis) ? spinAxis : 'z';
    return {
        engineBlade: {
            maxAccelRadPerS2: Number.isFinite(maxAccel) ? maxAccel : 24,
            maxOmegaRadPerS: Number.isFinite(maxOmega) ? maxOmega : 140,
            spinAxis: axis,
        },
    };
}

/**
 * @param {string} id
 * @returns {Promise<void>}
 */
async function selectAirframe(id) {
    selectedAirframeId = id;
    const data = await fetchJson(`/admin/addons/aircraft/airframes/${encodeURIComponent(id)}`);
    draftAirframe = data.airframe;
    syncFormFromDraft();
    await reloadPlaneManifestSelect();
    await reloadList();
    const manifest = String(draftAirframe?.prefabManifest || '').trim();
    if (manifest && viewer) {
        try {
            setStatus('プレハブを読み込み中…');
            await viewer.loadFromManifest(manifest);
            refreshPathDropdown();
            syncViewpointEditorOnViewer();
            applyMeshVisualPivotToViewer();
            setStatus('読み込み完了');
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            setStatus(`プレハブ読込失敗: ${msg}`, true);
        }
    } else if (viewer) {
        viewer.disposePrefabOnly();
        setStatus('マニフェスト未設定。左上でモデルをアップロードするか、右の一覧からプレハブを選んでください。');
    }
}

/**
 * @returns {void}
 */
function refreshPathDropdown() {
    const pathSel = /** @type {HTMLSelectElement|null} */ (document.getElementById('ac-path-select'));
    const root = viewer?.getPrefabRoot?.();
    if (!pathSel || !root) return;
    const paths = collectNamePaths(root);
    const keep = pathSel.value;
    pathSel.innerHTML = '<option value="">（パスを選択）</option>';
    for (const { path } of paths) {
        const opt = document.createElement('option');
        opt.value = path;
        opt.textContent = path;
        pathSel.appendChild(opt);
    }
    if (paths.some((p) => p.path === keep)) pathSel.value = keep;
}

/**
 * @returns {Promise<void>}
 */
async function saveDraft() {
    if (!draftAirframe?.id) {
        setStatus('機体を選択または追加してください', true);
        return;
    }
    const bindings = normalizeBindings(draftAirframe.bindings || {});
    const prevAnim =
        draftAirframe.animation && typeof draftAirframe.animation === 'object' ? draftAirframe.animation : {};
    const animation = { ...prevAnim, ...readAnimationFromForm() };
    if (activeRightTab === 'branch') readViewpointDetailIntoDraft();
    const meshEuler = readMeshVisualEulerFromForm();
    const camHardBase =
        draftAirframe.cameraHard && typeof draftAirframe.cameraHard === 'object'
            ? draftAirframe.cameraHard
            : draftAirframe.camera || {};
    const camEasyBase =
        draftAirframe.cameraEasy && typeof draftAirframe.cameraEasy === 'object'
            ? draftAirframe.cameraEasy
            : {};
    const hardVps = migrateLegacyCameraToViewpoints(camHardBase);
    const easyVps = migrateLegacyCameraToViewpoints(camEasyBase);
    const body = {
        displayName: String(document.getElementById('ac-field-display')?.value || '').trim(),
        prefabManifest: String(document.getElementById('ac-field-manifest')?.value || '').trim(),
        controlMode: readControlModeFromForm(),
        bindings,
        animation,
        flightPhysicsHard: readFlightPhysicsFromForm(),
        flightPhysicsEasy: readEasyFlightPhysicsFromForm(),
        cameraHard: buildCameraJsonForPut({ ...camHardBase, meshVisualEulerDeg: meshEuler }, hardVps),
        cameraEasy: buildCameraJsonForPut({ ...camEasyBase, meshVisualEulerDeg: meshEuler }, easyVps),
    };
    setStatus('保存中…');
    const data = await fetchJson(`/admin/addons/aircraft/airframes/${encodeURIComponent(draftAirframe.id)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    draftAirframe = data.airframe;
    syncFormFromDraft();
    setStatus('保存しました');
    await reloadPlaneManifestSelect();
    await reloadList();
}

/**
 * @returns {void}
 */
export function initAircraftAdminPanel() {
    if (mounted) return;
    const root = document.getElementById('panel-aircraft');
    if (!root) return;
    mounted = true;
    root.innerHTML = `
        <div class="ac-admin-layout">
            <aside class="ac-admin-left">
                <div class="ac-control-mode-toolbar">
                    <span class="prop-label">操縦モード（アップロード・新規機体時）</span>
                    <label class="ac-control-mode-opt"><input type="radio" name="ac-control-mode" value="hard" checked /> Hard（本格）</label>
                    <label class="ac-control-mode-opt"><input type="radio" name="ac-control-mode" value="easy" /> Easy（アーケード）</label>
                </div>
                <div class="ac-plane-upload-toolbar">
                    <button type="button" class="btn btn-secondary" id="ac-btn-upload-model">モデルをアップロードする</button>
                    <input type="file" id="ac-plane-zip-input" accept=".zip,application/zip" hidden />
                </div>
                <h2 class="section-title">飛行機ライブラリ</h2>
                <p class="hint">機体ごとに <code>plane/</code> 上のプレハブを選び、操縦パラメータ・カメラ・パーツロール・アニメーションを定義します。ワールドのオブジェクトでは <code>prefabManifest</code> とライブラリ機体 ID のリンクのみ行います。</p>
                <div class="ac-admin-actions">
                    <button type="button" class="btn btn-primary" id="ac-btn-add">機体を追加</button>
                    <button type="button" class="btn btn-secondary" id="ac-btn-delete" disabled>削除</button>
                </div>
                <div id="ac-airframe-list" class="ac-airframe-list"></div>
            </aside>
            <div class="ac-admin-center">
                <div id="ac-viewer-mount" class="ac-viewer-mount"></div>
                <p class="hint" id="ac-viewer-hint">クリックでオブジェクト選択（ハイライト）</p>
            </div>
            <aside class="ac-admin-right">
                <h3 class="section-subtitle">選択中の機体</h3>
                <div class="field-row"><label class="prop-label" for="ac-field-id">機体 ID</label>
                    <input type="text" id="ac-field-id" class="prop-input full" readonly /></div>
                <div class="field-row"><label class="prop-label" for="ac-field-display">表示名</label>
                    <input type="text" id="ac-field-display" class="prop-input full" /></div>
                <div class="field-row ac-control-mode-row">
                    <span class="prop-label">実行操縦モード</span>
                    <label class="ac-control-mode-opt"><input type="radio" name="ac-control-mode" value="hard" checked /> Hard</label>
                    <label class="ac-control-mode-opt"><input type="radio" name="ac-control-mode" value="easy" /> Easy</label>
                </div>
                <div class="field-row"><label class="prop-label" for="ac-field-manifest">prefab マニフェスト</label>
                    <input type="text" id="ac-field-manifest" class="prop-input full" readonly placeholder="plane/...-prefab-manifest.json" /></div>
                <div class="field-row">
                    <label class="prop-label" for="ac-manifest-select">プレハブモデル（plane/）</label>
                    <select id="ac-manifest-select" class="prop-input full">
                        <option value="">（読み込み中）</option>
                    </select>
                </div>
                <div class="ac-right-tabbar" role="tablist">
                    <button type="button" class="ac-tab-btn is-active" data-ac-tab="object" role="tab">オブジェクト定義</button>
                    <button type="button" class="ac-tab-btn" data-ac-tab="params" role="tab">パラメータ定義</button>
                    <button type="button" class="ac-tab-btn" data-ac-tab="branch" role="tab">支店定義</button>
                </div>
                <p class="hint" style="margin:6px 0 8px;font-size:11px;">「支店」タブでは機体ローカル座標の<strong>視点（カメラ）</strong>を編集します。ゲームでは <code>cockpit</code> / <code>chase</code> 役割の先頭1件ずつがコックピット視点・追従視点に使われます。</p>
                <div id="ac-pane-object" class="ac-tab-pane">
                    <h3 class="section-subtitle">ロール割当</h3>
                    <div class="field-row">
                        <label class="prop-label" for="ac-role-select">ロール</label>
                        <select id="ac-role-select" class="prop-input full"></select>
                    </div>
                    <div class="field-row">
                        <label class="prop-label" for="ac-path-select">オブジェクトパス</label>
                        <select id="ac-path-select" class="prop-input full"></select>
                    </div>
                    <button type="button" class="btn btn-primary" id="ac-btn-add-binding">選択パスをロールに追加</button>
                    <div id="ac-bindings-list" class="ac-bindings-list"></div>
                </div>
                <div id="ac-pane-params" class="ac-tab-pane" style="display:none">
                    <h3 class="section-subtitle">操縦パラメータ</h3>
                    <div class="ac-profile-tabbar" role="tablist">
                        <button type="button" class="ac-tab-btn is-active" data-ac-physics-profile="hard" role="tab">Hard</button>
                        <button type="button" class="ac-tab-btn" data-ac-physics-profile="easy" role="tab">Easy</button>
                    </div>
                    <div id="ac-physics-pane-hard"><div id="ac-flight-physics-mount"></div></div>
                    <div id="ac-physics-pane-easy" style="display:none"><div id="ac-flight-physics-easy-mount"></div></div>
                    <h3 class="section-subtitle">メッシュ見た目（°・YXZ）</h3>
                    <p class="hint" style="margin:0 0 8px;font-size:11px;">GLB 全体を機体ローカルで回すだけです。<strong>推力・ネット同期の前後はルートのまま</strong>なので、モデルの前向きと推進の見え方を合わせる用途に使います。</p>
                    <div class="prop-group-label">回転（Pitch X / Yaw Y / Roll Z）</div>
                    <div class="field-row"><label class="prop-label" for="ac-mesh-rx">Pitch X</label>
                        <input type="number" id="ac-mesh-rx" class="prop-input num" step="0.5" value="0" /></div>
                    <div class="field-row"><label class="prop-label" for="ac-mesh-ry">Yaw Y</label>
                        <input type="number" id="ac-mesh-ry" class="prop-input num" step="0.5" value="0" /></div>
                    <div class="field-row"><label class="prop-label" for="ac-mesh-rz">Roll Z</label>
                        <input type="number" id="ac-mesh-rz" class="prop-input num" step="0.5" value="0" /></div>
                    <h3 class="section-subtitle">アニメーション（エンジンブレード）</h3>
                    <div class="field-row"><label class="prop-label" for="ac-anim-maxaccel">角加速度上限 (rad/s²)</label>
                        <input type="number" id="ac-anim-maxaccel" class="prop-input num" step="0.5" min="0" /></div>
                    <div class="field-row"><label class="prop-label" for="ac-anim-maxomega">目標角速度上限 (rad/s)</label>
                        <input type="number" id="ac-anim-maxomega" class="prop-input num" step="1" min="0" /></div>
                    <div class="field-row"><label class="prop-label" for="ac-anim-spinaxis">回転軸（ローカル）</label>
                        <select id="ac-anim-spinaxis" class="prop-input full"><option value="x">x</option><option value="y">y</option><option value="z">z</option></select></div>
                </div>
                <div id="ac-pane-branch" class="ac-tab-pane" style="display:none">
                    <h3 class="section-subtitle">視点（カメラ）</h3>
                    <div class="ac-profile-tabbar" role="tablist">
                        <button type="button" class="ac-tab-btn is-active" data-ac-vp-profile="hard" role="tab">Hard 視点</button>
                        <button type="button" class="ac-tab-btn" data-ac-vp-profile="easy" role="tab">Easy 視点</button>
                    </div>
                    <p class="hint" style="margin:0 0 8px;">3D 上のマーカーをドラッグするか、数値・矢印キーで移動。ビューアを一度クリックしてからキー操作してください。</p>
                    <div class="ac-admin-actions" style="margin-top:0;">
                        <button type="button" class="btn btn-sm btn-primary" id="ac-vp-add">視点を追加</button>
                        <button type="button" class="btn btn-sm btn-outline-secondary" id="ac-vp-del">削除</button>
                    </div>
                    <div class="field-row">
                        <label class="prop-label" for="ac-vp-select">視点一覧</label>
                        <select id="ac-vp-select" class="prop-input full" size="5" style="min-height:100px;"></select>
                    </div>
                    <div class="field-row"><label class="prop-label" for="ac-vp-name">表示名</label>
                        <input type="text" id="ac-vp-name" class="prop-input full" placeholder="例: メインコックピット" /></div>
                    <div class="field-row">
                        <label class="prop-label" for="ac-vp-role">役割</label>
                        <select id="ac-vp-role" class="prop-input full">
                            <option value="cockpit">cockpit（コックピット視点に使用）</option>
                            <option value="chase">chase（追従視点に使用）</option>
                            <option value="free">free（参照用・ゲームでは未使用）</option>
                        </select>
                    </div>
                    <div class="prop-group-label">位置（機体ローカル m）</div>
                    <div class="field-row"><label class="prop-label" for="ac-vp-px">X</label>
                        <input type="number" id="ac-vp-px" class="prop-input num" step="0.05" /></div>
                    <div class="field-row"><label class="prop-label" for="ac-vp-py">Y</label>
                        <input type="number" id="ac-vp-py" class="prop-input num" step="0.05" /></div>
                    <div class="field-row"><label class="prop-label" for="ac-vp-pz">Z</label>
                        <input type="number" id="ac-vp-pz" class="prop-input num" step="0.05" /></div>
                    <div class="prop-group-label">回転（°・YXZ）</div>
                    <div class="field-row"><label class="prop-label" for="ac-vp-rx">Pitch X</label>
                        <input type="number" id="ac-vp-rx" class="prop-input num" step="0.5" /></div>
                    <div class="field-row"><label class="prop-label" for="ac-vp-ry">Yaw Y</label>
                        <input type="number" id="ac-vp-ry" class="prop-input num" step="0.5" /></div>
                    <div class="field-row"><label class="prop-label" for="ac-vp-rz">Roll Z</label>
                        <input type="number" id="ac-vp-rz" class="prop-input num" step="0.5" /></div>
                    <div class="ac-admin-actions" style="margin-top:4px;">
                        <button type="button" class="btn btn-sm btn-secondary" id="ac-vp-mode-trans">移動ギズモ</button>
                        <button type="button" class="btn btn-sm btn-secondary" id="ac-vp-mode-rot">回転ギズモ</button>
                    </div>
                </div>
                <div class="ac-admin-actions">
                    <button type="button" class="btn btn-primary" id="ac-btn-save">保存</button>
                </div>
                <p id="ac-admin-status" class="status-text" role="status"></p>
            </aside>
        </div>
    `;

    mountFlightPhysicsForm(document.getElementById('ac-flight-physics-mount'));
    mountEasyFlightPhysicsForm(document.getElementById('ac-flight-physics-easy-mount'));
    setActivePhysicsProfile('hard');

    const mount = document.getElementById('ac-viewer-mount');
    if (mount) {
        viewer = new AdminAircraftPrefabViewer(mount);
        viewer.onSelectionChange = (path) => {
            const pathSel = /** @type {HTMLSelectElement|null} */ (document.getElementById('ac-path-select'));
            if (pathSel && path) {
                const opt = [...pathSel.options].find((o) => o.value === path);
                if (opt) pathSel.value = path;
            }
        };
    }

    document.getElementById('ac-btn-add')?.addEventListener('click', async () => {
        const id = window.prompt('機体 ID（英数字・-_ のみ、例: b787）', 'b787');
        if (!id || !/^[a-zA-Z0-9_-]{1,64}$/.test(id.trim())) {
            setStatus('ID が不正です', true);
            return;
        }
        const displayName = window.prompt('表示名', id.trim()) || id.trim();
        try {
            await fetchJson(`/admin/addons/aircraft/airframes/${encodeURIComponent(id.trim())}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    displayName,
                    prefabManifest: '',
                    controlMode: readControlModeFromForm(),
                    bindings: {},
                    animation: defaultAnimationJson(),
                }),
            });
            selectedAirframeId = id.trim();
            await selectAirframe(selectedAirframeId);
            setStatus('機体を作成しました');
        } catch (e) {
            setStatus(e instanceof Error ? e.message : String(e), true);
        }
    });

    document.getElementById('ac-btn-delete')?.addEventListener('click', async () => {
        if (!draftAirframe?.id) return;
        if (!window.confirm(`削除しますか？ ${draftAirframe.id}`)) return;
        try {
            await fetchJson(`/admin/addons/aircraft/airframes/${encodeURIComponent(draftAirframe.id)}`, {
                method: 'DELETE',
            });
            draftAirframe = null;
            selectedAirframeId = null;
            viewer?.disposePrefabOnly();
            syncFormFromDraft();
            await reloadPlaneManifestSelect();
            await reloadList();
            setStatus('削除しました');
        } catch (e) {
            setStatus(e instanceof Error ? e.message : String(e), true);
        }
    });

    document.getElementById('ac-btn-save')?.addEventListener('click', () => {
        void saveDraft().catch((e) => setStatus(e instanceof Error ? e.message : String(e), true));
    });

    document.getElementById('ac-btn-add-binding')?.addEventListener('click', () => {
        if (!draftAirframe) return;
        const role = /** @type {HTMLSelectElement|null} */ (document.getElementById('ac-role-select'))?.value;
        const pathSel = /** @type {HTMLSelectElement|null} */ (document.getElementById('ac-path-select'));
        let path = pathSel?.value?.trim() || '';
        if (!path && viewer) path = viewer.getSelectionPath() || '';
        if (!role || !path) {
            setStatus('ロールとパスを選んでください', true);
            return;
        }
        const arr = bindingPathsForRole(draftAirframe.bindings, role);
        if (arr.includes(path)) {
            setStatus('そのパスは既にこのロールにあります', true);
            return;
        }
        const b = { ...(draftAirframe.bindings || {}) };
        b[role] = [...arr, path];
        draftAirframe.bindings = normalizeBindings(b);
        syncFormFromDraft();
        setStatus(`追加: ${role} ← ${path}`);
    });

    document.getElementById('ac-path-select')?.addEventListener('change', (ev) => {
        const v = /** @type {HTMLSelectElement} */ (ev.target).value;
        if (v && viewer) viewer.selectByPath(v);
    });

    document.getElementById('ac-btn-upload-model')?.addEventListener('click', () => {
        document.getElementById('ac-plane-zip-input')?.click();
    });

    document.getElementById('ac-plane-zip-input')?.addEventListener('change', async (ev) => {
        const input = /** @type {HTMLInputElement} */ (ev.target);
        const file = input.files && input.files[0];
        input.value = '';
        if (!file) return;
        if (!String(file.name || '').toLowerCase().endsWith('.zip')) {
            setStatus('.zip のみ', true);
            return;
        }
        try {
            setStatus('モデル ZIP をアップロード中…');
            const json = await uploadPrefabZip(file, '/admin/upload-plane-prefab-zip');
            const pm = String(json.prefabManifest || '').trim();
            if (!pm) throw new Error('no_prefab_manifest_in_response');
            await reloadPlaneManifestSelect();
            if (draftAirframe) {
                draftAirframe.controlMode = readControlModeFromForm();
            }
            setStatus(`アップロード完了: ${pm}（操縦モード: ${readControlModeFromForm()}）`);
        } catch (e) {
            if (e instanceof Error && e.message === 'cancelled') {
                setStatus('キャンセルしました');
            } else {
                setStatus(e instanceof Error ? e.message : String(e), true);
            }
        }
    });

    document.getElementById('ac-manifest-select')?.addEventListener('change', async (ev) => {
        if (!draftAirframe?.id) {
            setStatus('先に機体を選択してください', true);
            return;
        }
        const v = /** @type {HTMLSelectElement} */ (ev.target).value.trim();
        const el = document.getElementById('ac-field-manifest');
        if (!v) {
            draftAirframe.prefabManifest = '';
            if (el && 'value' in el) /** @type {HTMLInputElement} */ (el).value = '';
            viewer?.disposePrefabOnly();
            syncFormFromDraft();
            await saveDraft();
            return;
        }
        draftAirframe.prefabManifest = v;
        if (el && 'value' in el) /** @type {HTMLInputElement} */ (el).value = v;
        try {
            setStatus('プレハブを読み込み中…');
            await viewer?.loadFromManifest(v);
            refreshPathDropdown();
            syncViewpointEditorOnViewer();
            applyMeshVisualPivotToViewer();
            await saveDraft();
        } catch (e) {
            setStatus(e instanceof Error ? e.message : String(e), true);
        }
    });

    document.querySelectorAll('.ac-tab-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
            const el = /** @type {HTMLElement} */ (btn);
            const t = el.dataset.acTab;
            if (t === 'object' || t === 'params' || t === 'branch') setActiveRightTab(t);
            const phys = el.dataset.acPhysicsProfile;
            if (phys === 'hard' || phys === 'easy') setActivePhysicsProfile(phys);
            const vp = el.dataset.acVpProfile;
            if (vp === 'hard' || vp === 'easy') setActiveViewpointProfile(vp);
        });
    });

    document.querySelectorAll('input[name="ac-control-mode"]').forEach((inp) => {
        inp.addEventListener('change', () => {
            if (draftAirframe) draftAirframe.controlMode = readControlModeFromForm();
        });
    });

    for (const id of ['ac-mesh-rx', 'ac-mesh-ry', 'ac-mesh-rz']) {
        document.getElementById(id)?.addEventListener('input', () => applyMeshVisualPivotToViewer());
    }

    document.getElementById('ac-vp-add')?.addEventListener('click', () => {
        if (!draftAirframe) return;
        const vps = [...getViewpointsList()];
        const id = `vp_${Date.now()}`;
        vps.push({
            id,
            name: `視点_${vps.length + 1}`,
            role: 'free',
            position: { x: 0, y: 2, z: 10 },
            eulerDeg: { x: 0, y: 0, z: 0 },
        });
        applyViewpointsToDraftCamera(vps);
        selectedViewpointId = id;
        syncViewpointPanelFromDraft();
        setStatus(`視点を追加: ${id}`);
    });

    document.getElementById('ac-vp-del')?.addEventListener('click', () => {
        if (!draftAirframe || !selectedViewpointId) return;
        const vps = getViewpointsList().filter((v) => v.id !== selectedViewpointId);
        if (!vps.length) {
            setStatus('最低 1 件の視点が必要です', true);
            return;
        }
        applyViewpointsToDraftCamera(vps);
        selectedViewpointId = vps[0]?.id || null;
        syncViewpointPanelFromDraft();
        setStatus('視点を削除しました');
    });

    document.getElementById('ac-vp-select')?.addEventListener('change', (ev) => {
        selectedViewpointId = /** @type {HTMLSelectElement} */ (ev.target).value || null;
        fillViewpointDetailInputs();
        viewer?.setSelectedViewpointId(selectedViewpointId, getViewpointsList());
    });

    for (const id of ['ac-vp-name', 'ac-vp-role', 'ac-vp-px', 'ac-vp-py', 'ac-vp-pz', 'ac-vp-rx', 'ac-vp-ry', 'ac-vp-rz']) {
        document.getElementById(id)?.addEventListener('change', () => {
            readViewpointDetailIntoDraft();
        });
    }

    document.getElementById('ac-vp-mode-trans')?.addEventListener('click', () => {
        viewer?.setViewpointTransformMode('translate');
    });
    document.getElementById('ac-vp-mode-rot')?.addEventListener('click', () => {
        viewer?.setViewpointTransformMode('rotate');
    });

    acVpKeydownHandler = (e) => {
        if (activeRightTab !== 'branch' || !viewer) return;
        const canvas = document.querySelector('#ac-viewer-mount canvas');
        if (!canvas || document.activeElement !== canvas) return;
        const step = e.shiftKey ? 0.02 : 0.1;
        if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'PageUp', 'PageDown'].includes(e.code)) {
            e.preventDefault();
        }
        if (e.code === 'ArrowLeft') viewer.nudgeSelectedViewpoint(-step, 0, 0);
        else if (e.code === 'ArrowRight') viewer.nudgeSelectedViewpoint(step, 0, 0);
        else if (e.code === 'ArrowUp') viewer.nudgeSelectedViewpoint(0, step, 0);
        else if (e.code === 'ArrowDown') viewer.nudgeSelectedViewpoint(0, -step, 0);
        else if (e.code === 'PageUp') viewer.nudgeSelectedViewpoint(0, 0, step);
        else if (e.code === 'PageDown') viewer.nudgeSelectedViewpoint(0, 0, -step);
    };
    document.addEventListener('keydown', acVpKeydownHandler);

    refreshRightTabVisibility();

    void (async () => {
        await reloadPlaneManifestSelect();
        await reloadList();
        if (selectedAirframeId) {
            await selectAirframe(selectedAirframeId).catch((e) => setStatus(String(e), true));
        }
    })();

    const delBtn = document.getElementById('ac-btn-delete');
    if (delBtn) delBtn.disabled = !draftAirframe?.id;
}

/**
 * パネル非表示時にビューアを破棄する（任意・メモリ節約）
 * @returns {void}
 */
export function disposeAircraftAdminPanel() {
    if (acVpKeydownHandler) {
        document.removeEventListener('keydown', acVpKeydownHandler);
        acVpKeydownHandler = null;
    }
    if (viewer) {
        viewer.dispose();
        viewer = null;
    }
    mounted = false;
}
