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

let mounted = false;
/** @type {AdminAircraftPrefabViewer|null} */
let viewer = null;
/** @type {string|null} */
let selectedAirframeId = null;
/** @type {object|null} */
let draftAirframe = null;

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
        btn.textContent = `${a.id} — ${a.displayName || '(無名)'}`;
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
    fillFlightPhysicsForm(d?.flightPhysics);
    fillCameraFromDraft(d?.camera);
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
 * @returns {Record<string, unknown>}
 */
function readCameraFromForm() {
    const p = (id) => {
        const el = document.getElementById(id);
        const n = el && 'value' in el ? parseFloat(/** @type {HTMLInputElement} */ (el).value) : NaN;
        return Number.isFinite(n) ? n : 0;
    };
    return {
        cockpitOffset: { x: p('ac-cam-cockpit-x'), y: p('ac-cam-cockpit-y'), z: p('ac-cam-cockpit-z') },
        chaseOffset: { x: p('ac-cam-chase-x'), y: p('ac-cam-chase-y'), z: p('ac-cam-chase-z') },
        cockpitEulerDeg: { x: p('ac-cam-cockpit-rx'), y: p('ac-cam-cockpit-ry'), z: p('ac-cam-cockpit-rz') },
        chaseEulerDeg: { x: p('ac-cam-chase-rx'), y: p('ac-cam-chase-ry'), z: p('ac-cam-chase-rz') },
    };
}

/**
 * @param {unknown} camRaw
 */
function fillCameraFromDraft(camRaw) {
    const c = camRaw && typeof camRaw === 'object' && !Array.isArray(camRaw) ? camRaw : {};
    const ck = /** @type {{x?:number,y?:number,z?:number}} */ (c.cockpitOffset) || {};
    const ch = /** @type {{x?:number,y?:number,z?:number}} */ (c.chaseOffset) || {};
    const set = (id, v) => {
        const el = document.getElementById(id);
        if (el && 'value' in el) /** @type {HTMLInputElement} */ (el).value = String(v);
    };
    set('ac-cam-cockpit-x', ck.x ?? 0);
    set('ac-cam-cockpit-y', ck.y ?? 1.2);
    set('ac-cam-cockpit-z', ck.z ?? 0);
    set('ac-cam-chase-x', ch.x ?? 0);
    set('ac-cam-chase-y', ch.y ?? 3);
    set('ac-cam-chase-z', ch.z ?? 12);
    const ce = /** @type {{x?:number,y?:number,z?:number}} */ (c.cockpitEulerDeg) || {};
    const se = /** @type {{x?:number,y?:number,z?:number}} */ (c.chaseEulerDeg) || {};
    set('ac-cam-cockpit-rx', ce.x ?? 0);
    set('ac-cam-cockpit-ry', ce.y ?? 0);
    set('ac-cam-cockpit-rz', ce.z ?? 0);
    set('ac-cam-chase-rx', se.x ?? 0);
    set('ac-cam-chase-ry', se.y ?? 0);
    set('ac-cam-chase-rz', se.z ?? 0);
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
    const body = {
        displayName: String(document.getElementById('ac-field-display')?.value || '').trim(),
        prefabManifest: String(document.getElementById('ac-field-manifest')?.value || '').trim(),
        bindings,
        animation,
        flightPhysics: readFlightPhysicsFromForm(),
        camera: readCameraFromForm(),
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
                <p class="hint">クリックでオブジェクト選択（ハイライト）</p>
            </div>
            <aside class="ac-admin-right">
                <h3 class="section-subtitle">選択中の機体</h3>
                <div class="field-row"><label class="prop-label" for="ac-field-id">機体 ID</label>
                    <input type="text" id="ac-field-id" class="prop-input full" readonly /></div>
                <div class="field-row"><label class="prop-label" for="ac-field-display">表示名</label>
                    <input type="text" id="ac-field-display" class="prop-input full" /></div>
                <div class="field-row"><label class="prop-label" for="ac-field-manifest">prefab マニフェスト</label>
                    <input type="text" id="ac-field-manifest" class="prop-input full" readonly placeholder="plane/...-prefab-manifest.json" /></div>
                <div class="field-row">
                    <label class="prop-label" for="ac-manifest-select">プレハブモデル（plane/）</label>
                    <select id="ac-manifest-select" class="prop-input full">
                        <option value="">（読み込み中）</option>
                    </select>
                </div>
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
                <h3 class="section-subtitle">操縦パラメータ</h3>
                <div id="ac-flight-physics-mount"></div>
                <h3 class="section-subtitle">コックピット／追従カメラ（機体ローカル）</h3>
                <p class="hint" style="margin:0 0 8px;">位置は m、回転は度（機体ローカル）。ライブラリ連携ワールドはゲーム起動時に API で再読込されます。</p>
                <div class="prop-group-label">コックピット視点・位置</div>
                <div class="field-row"><label class="prop-label" for="ac-cam-cockpit-x">X</label>
                    <input type="number" id="ac-cam-cockpit-x" class="prop-input num" step="0.05" value="0" /></div>
                <div class="field-row"><label class="prop-label" for="ac-cam-cockpit-y">Y</label>
                    <input type="number" id="ac-cam-cockpit-y" class="prop-input num" step="0.05" value="1.2" /></div>
                <div class="field-row"><label class="prop-label" for="ac-cam-cockpit-z">Z</label>
                    <input type="number" id="ac-cam-cockpit-z" class="prop-input num" step="0.05" value="0" /></div>
                <div class="prop-group-label">コックピット視点・回転（°）</div>
                <div class="field-row"><label class="prop-label" for="ac-cam-cockpit-rx">Pitch X</label>
                    <input type="number" id="ac-cam-cockpit-rx" class="prop-input num" step="0.5" value="0" /></div>
                <div class="field-row"><label class="prop-label" for="ac-cam-cockpit-ry">Yaw Y</label>
                    <input type="number" id="ac-cam-cockpit-ry" class="prop-input num" step="0.5" value="0" /></div>
                <div class="field-row"><label class="prop-label" for="ac-cam-cockpit-rz">Roll Z</label>
                    <input type="number" id="ac-cam-cockpit-rz" class="prop-input num" step="0.5" value="0" /></div>
                <div class="prop-group-label">追従カメラ・位置（+Z は後方寄り）</div>
                <div class="field-row"><label class="prop-label" for="ac-cam-chase-x">X</label>
                    <input type="number" id="ac-cam-chase-x" class="prop-input num" step="0.05" value="0" /></div>
                <div class="field-row"><label class="prop-label" for="ac-cam-chase-y">Y</label>
                    <input type="number" id="ac-cam-chase-y" class="prop-input num" step="0.05" value="3" /></div>
                <div class="field-row"><label class="prop-label" for="ac-cam-chase-z">Z</label>
                    <input type="number" id="ac-cam-chase-z" class="prop-input num" step="0.05" value="12" /></div>
                <div class="prop-group-label">追従カメラ・回転（°）</div>
                <div class="field-row"><label class="prop-label" for="ac-cam-chase-rx">Pitch X</label>
                    <input type="number" id="ac-cam-chase-rx" class="prop-input num" step="0.5" value="0" /></div>
                <div class="field-row"><label class="prop-label" for="ac-cam-chase-ry">Yaw Y</label>
                    <input type="number" id="ac-cam-chase-ry" class="prop-input num" step="0.5" value="0" /></div>
                <div class="field-row"><label class="prop-label" for="ac-cam-chase-rz">Roll Z</label>
                    <input type="number" id="ac-cam-chase-rz" class="prop-input num" step="0.5" value="0" /></div>
                <h3 class="section-subtitle">アニメーション（エンジンブレード）</h3>
                <div class="field-row"><label class="prop-label" for="ac-anim-maxaccel">角加速度上限 (rad/s²)</label>
                    <input type="number" id="ac-anim-maxaccel" class="prop-input num" step="0.5" min="0" /></div>
                <div class="field-row"><label class="prop-label" for="ac-anim-maxomega">目標角速度上限 (rad/s)</label>
                    <input type="number" id="ac-anim-maxomega" class="prop-input num" step="1" min="0" /></div>
                <div class="field-row"><label class="prop-label" for="ac-anim-spinaxis">回転軸（ローカル）</label>
                    <select id="ac-anim-spinaxis" class="prop-input full"><option value="x">x</option><option value="y">y</option><option value="z">z</option></select></div>
                <div class="ac-admin-actions">
                    <button type="button" class="btn btn-primary" id="ac-btn-save">保存</button>
                </div>
                <p id="ac-admin-status" class="status-text" role="status"></p>
            </aside>
        </div>
    `;

    mountFlightPhysicsForm(document.getElementById('ac-flight-physics-mount'));

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
            setStatus(`アップロード完了: ${pm}`);
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
            await saveDraft();
        } catch (e) {
            setStatus(e instanceof Error ? e.message : String(e), true);
        }
    });

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
    if (viewer) {
        viewer.dispose();
        viewer = null;
    }
    mounted = false;
}
