// public/js/aircraft/map-admin-panel.js — 飛行ミニマップ「Map定義」管理 UI

import { AdminMapSpotWorldViewer } from './map-spot-world-viewer.js';

/** @type {boolean} */
let mapMounted = false;
/** @type {string|null} */
let selectedWorldId = null;
/** @type {object|null} */
let draftMap = null;
/** @type {string|null} */
let selectedSpotId = null;
/** @type {AdminMapSpotWorldViewer|null} */
let spotViewer = null;
/** @type {Record<string, object>|null} */
let worldsCache = null;

/** @type {Record<string, { x: number, z: number }>} */
const NORTH_PRESETS = {
    '-Z': { x: 0, z: -1 },
    '+Z': { x: 0, z: 1 },
    '-X': { x: -1, z: 0 },
    '+X': { x: 1, z: 0 },
};

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
 * @param {string} msg
 * @param {boolean} [isError]
 */
function setMapStatus(msg, isError = false) {
    const el = document.getElementById('ac-map-status');
    if (!el) return;
    el.textContent = msg;
    el.style.color = isError ? '#c62828' : '';
}

/**
 * @returns {object}
 */
function defaultMapConfig() {
    return {
        northDirection: { x: 0, z: -1 },
        minimapRadiusM: 800,
        aircraftIconOffsetDeg: 0,
        spots: [],
    };
}

/**
 * 北方向プリセットを UI から読む
 * @returns {{ x: number, z: number }}
 */
function readNorthFromForm() {
    const preset = /** @type {HTMLSelectElement|null} */ (
        document.getElementById('ac-map-north-preset')
    )?.value;
    if (preset && preset !== 'custom' && NORTH_PRESETS[preset]) {
        return { ...NORTH_PRESETS[preset] };
    }
    const num = (id, fallback) => {
        const el = /** @type {HTMLInputElement|null} */ (document.getElementById(id));
        const v = el ? Number(el.value) : NaN;
        return Number.isFinite(v) ? v : fallback;
    };
    let x = num('ac-map-north-x', 0);
    let z = num('ac-map-north-z', -1);
    const len = Math.hypot(x, z);
    if (len < 1e-9) return { x: 0, z: -1 };
    return { x: x / len, z: z / len };
}

/**
 * 北方向 UI を config から反映
 * @param {{ x: number, z: number }} north
 */
function syncNorthForm(north) {
    const sel = /** @type {HTMLSelectElement|null} */ (document.getElementById('ac-map-north-preset'));
    const custom = document.getElementById('ac-map-north-custom');
    if (!sel) return;
    const presetKey = Object.entries(NORTH_PRESETS).find(
        ([, v]) => Math.abs(v.x - north.x) < 0.001 && Math.abs(v.z - north.z) < 0.001
    )?.[0];
    if (presetKey) {
        sel.value = presetKey;
        if (custom) custom.style.display = 'none';
    } else {
        sel.value = 'custom';
        if (custom) custom.style.display = 'block';
        const nx = /** @type {HTMLInputElement|null} */ (document.getElementById('ac-map-north-x'));
        const nz = /** @type {HTMLInputElement|null} */ (document.getElementById('ac-map-north-z'));
        if (nx) nx.value = String(north.x);
        if (nz) nz.value = String(north.z);
    }
}

/**
 * @param {object|null|undefined} map
 */
function syncMapFormFromDraft(map) {
    draftMap = map;
    const cfg = map?.config || defaultMapConfig();
    const setNum = (id, v) => {
        const el = /** @type {HTMLInputElement|null} */ (document.getElementById(id));
        if (el) el.value = String(v ?? '');
    };
    syncNorthForm(cfg.northDirection || { x: 0, z: -1 });
    setNum('ac-map-radius', cfg.minimapRadiusM ?? 800);
    setNum('ac-map-icon-offset', cfg.aircraftIconOffsetDeg ?? 0);
    renderSpotList();
    if (spotViewer) spotViewer.setSpotMarkers(cfg.spots || []);
}

/**
 * フォームから draftMap.config を更新する
 */
function readConfigFromForm() {
    const num = (id, fallback) => {
        const el = /** @type {HTMLInputElement|null} */ (document.getElementById(id));
        const v = el ? Number(el.value) : NaN;
        return Number.isFinite(v) ? v : fallback;
    };
    return {
        northDirection: readNorthFromForm(),
        minimapRadiusM: num('ac-map-radius', 800),
        aircraftIconOffsetDeg: num('ac-map-icon-offset', 0),
        spots: draftMap?.config?.spots ? [...draftMap.config.spots] : [],
    };
}

/**
 * スポット一覧を描画する
 */
function renderSpotList() {
    const list = document.getElementById('ac-map-spot-list');
    if (!list) return;
    const spots = draftMap?.config?.spots || [];
    if (!spots.length) {
        list.innerHTML = '<p class="hint">「スポット定義」でワールド上をクリックして追加</p>';
        return;
    }
    list.innerHTML = spots
        .map(
            (s) =>
                `<button type="button" class="ac-map-spot-item${s.id === selectedSpotId ? ' is-selected' : ''}" data-spot-id="${s.id}">` +
                `<span class="ac-map-spot-name">${escapeHtml(s.name)}</span>` +
                `<span class="ac-map-spot-coord">X=${s.x.toFixed(1)} Z=${s.z.toFixed(1)}</span>` +
                `</button>`
        )
        .join('');
    list.querySelectorAll('[data-spot-id]').forEach((btn) => {
        btn.addEventListener('click', () => {
            selectedSpotId = btn.getAttribute('data-spot-id');
            renderSpotList();
        });
    });
}

/**
 * @param {string} s
 * @returns {string}
 */
function escapeHtml(s) {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/**
 * 新規スポット ID を生成する
 * @returns {string}
 */
function nextSpotId() {
    const spots = draftMap?.config?.spots || [];
    let n = spots.length + 1;
    while (spots.some((s) => s.id === `spot-${n}`)) n += 1;
    return `spot-${n}`;
}

/**
 * @param {string} worldId
 */
async function selectWorld(worldId) {
    selectedWorldId = worldId;
    selectedSpotId = null;
    closeSpotModal();
    const sel = /** @type {HTMLSelectElement|null} */ (document.getElementById('ac-map-world-select'));
    if (sel) sel.value = worldId;
    try {
        const j = await fetchJson(`/admin/addons/aircraft/flight-maps/${encodeURIComponent(worldId)}`);
        draftMap = j.map || {
            worldId,
            config: defaultMapConfig(),
        };
        syncMapFormFromDraft(draftMap);
        setMapStatus('');
    } catch (e) {
        setMapStatus(e instanceof Error ? e.message : String(e), true);
    }
}

/**
 * ワールド一覧セレクトを構築する
 */
async function reloadWorldSelect() {
    const sel = /** @type {HTMLSelectElement|null} */ (document.getElementById('ac-map-world-select'));
    if (!sel) return;
    try {
        worldsCache = await fetchJson('/admin/worlds');
    } catch {
        worldsCache = {};
    }
    sel.innerHTML = '';
    const ids = Object.keys(worldsCache).sort();
    for (const id of ids) {
        const opt = document.createElement('option');
        opt.value = id;
        opt.textContent = worldsCache[id]?.name ? `${worldsCache[id].name} (${id})` : id;
        sel.appendChild(opt);
    }
    if (!ids.length) {
        const opt = document.createElement('option');
        opt.value = '';
        opt.textContent = '（ワールドなし）';
        sel.appendChild(opt);
        return;
    }
    const pick = selectedWorldId && ids.includes(selectedWorldId) ? selectedWorldId : ids[0];
    await selectWorld(pick);
}

/**
 * 定義を保存する
 */
async function saveMapDraft() {
    if (!selectedWorldId || !draftMap) return;
    const config = readConfigFromForm();
    try {
        const j = await fetchJson(
            `/admin/addons/aircraft/flight-maps/${encodeURIComponent(selectedWorldId)}`,
            {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ config }),
            }
        );
        draftMap = j.map;
        syncMapFormFromDraft(draftMap);
        setMapStatus('保存しました');
    } catch (e) {
        setMapStatus(e instanceof Error ? e.message : String(e), true);
    }
}

/**
 * スポット定義ビューアを破棄する
 */
function disposeSpotViewer() {
    if (spotViewer) {
        spotViewer.dispose();
        spotViewer = null;
    }
}

/**
 * スポット定義モーダルを閉じる
 */
function closeSpotModal() {
    const modal = document.getElementById('ac-map-spot-modal');
    if (modal) modal.hidden = true;
    disposeSpotViewer();
}

/**
 * スポット定義モーダルを開きワールドを読み込む
 */
async function openSpotDefinitionModal() {
    if (!selectedWorldId) {
        setMapStatus('ワールドを選択してください', true);
        return;
    }
    const world = worldsCache?.[selectedWorldId];
    if (!world) {
        setMapStatus('ワールドデータが見つかりません', true);
        return;
    }
    const modal = document.getElementById('ac-map-spot-modal');
    const mount = document.getElementById('ac-map-spot-viewer-mount');
    if (!modal || !mount) return;
    disposeSpotViewer();
    mount.innerHTML = '';
    modal.hidden = false;
    setMapStatus('ワールドを読み込み中…');
    spotViewer = new AdminMapSpotWorldViewer(mount);
    spotViewer.setSpotMarkers(draftMap?.config?.spots || []);
    spotViewer.onSpotPick = (x, z) => {
        const name = window.prompt('スポット名', 'スポット');
        if (name == null || !name.trim()) return;
        const cfg = readConfigFromForm();
        const id = nextSpotId();
        cfg.spots.push({ id, name: name.trim(), x, z });
        if (!draftMap) draftMap = { worldId: selectedWorldId, config: defaultMapConfig() };
        draftMap.config = cfg;
        selectedSpotId = id;
        syncMapFormFromDraft(draftMap);
        setMapStatus(`スポット追加: ${name.trim()} (X=${x.toFixed(1)}, Z=${z.toFixed(1)})`);
    };
    try {
        await spotViewer.loadWorld(world);
        setMapStatus('クリックでスポットを追加（ドラッグはカメラ操作）');
    } catch (e) {
        setMapStatus(e instanceof Error ? e.message : String(e), true);
    }
}

/**
 * @param {HTMLElement} root
 * @returns {void}
 */
export function mountAircraftMapAdminPanel(root) {
    if (mapMounted) return;
    mapMounted = true;
    root.innerHTML = `
        <div class="ac-map-admin-layout">
            <aside class="ac-map-admin-left">
                <h2 class="section-title">Map定義</h2>
                <p class="hint">操縦中ミニマップは<strong>上から見下ろし</strong>（機体中心・北固定）です。スポットは 3D ワールド上でクリックして XZ 座標を登録します。</p>
                <div class="field-row">
                    <label class="prop-label" for="ac-map-world-select">対象ワールド</label>
                    <select id="ac-map-world-select" class="prop-input full"></select>
                </div>
                <div class="prop-group-label">北方向（ミニマップ上端）</div>
                <div class="field-row">
                    <label class="prop-label" for="ac-map-north-preset">北の向き</label>
                    <select id="ac-map-north-preset" class="prop-input full">
                        <option value="-Z">-Z 軸（Three.js デフォルト前方）</option>
                        <option value="+Z">+Z 軸</option>
                        <option value="-X">-X 軸</option>
                        <option value="+X">+X 軸</option>
                        <option value="custom">カスタム（XZ ベクトル）</option>
                    </select>
                </div>
                <div id="ac-map-north-custom" style="display:none">
                    <div class="field-row"><label class="prop-label" for="ac-map-north-x">北 X</label>
                        <input type="number" id="ac-map-north-x" class="prop-input num" step="0.01" value="0" /></div>
                    <div class="field-row"><label class="prop-label" for="ac-map-north-z">北 Z</label>
                        <input type="number" id="ac-map-north-z" class="prop-input num" step="0.01" value="-1" /></div>
                </div>
                <div class="field-row"><label class="prop-label" for="ac-map-radius">表示半径 (m)</label>
                    <input type="number" id="ac-map-radius" class="prop-input num" step="50" min="50" /></div>
                <div class="field-row"><label class="prop-label" for="ac-map-icon-offset">機体アイコン向き補正 (°)</label>
                    <input type="number" id="ac-map-icon-offset" class="prop-input num" step="1" /></div>
                <div class="ac-admin-actions">
                    <button type="button" class="btn btn-secondary" id="ac-map-btn-spots">スポット定義</button>
                    <button type="button" class="btn btn-primary" id="ac-map-btn-save">保存</button>
                </div>
                <p id="ac-map-status" class="status-text" role="status"></p>
            </aside>
            <aside class="ac-map-admin-right ac-map-admin-right-wide">
                <h3 class="section-subtitle">スポット一覧</h3>
                <div class="ac-admin-actions">
                    <button type="button" class="btn btn-sm btn-outline-secondary" id="ac-map-spot-rename">名前変更</button>
                    <button type="button" class="btn btn-sm btn-outline-secondary" id="ac-map-spot-delete">削除</button>
                </div>
                <div id="ac-map-spot-list" class="ac-map-spot-list"></div>
            </aside>
        </div>
        <div id="ac-map-spot-modal" class="ac-map-spot-modal" hidden>
            <div class="ac-map-spot-modal-inner">
                <header class="ac-map-spot-modal-header">
                    <span>スポット定義 — ワールド上をクリック（XZ 座標）</span>
                    <button type="button" class="btn btn-sm btn-secondary" id="ac-map-spot-close">閉じる</button>
                </header>
                <div id="ac-map-spot-viewer-mount" class="ac-map-spot-viewer-mount"></div>
            </div>
        </div>
    `;

    document.getElementById('ac-map-world-select')?.addEventListener('change', (e) => {
        const id = /** @type {HTMLSelectElement} */ (e.target).value;
        if (id) void selectWorld(id);
    });

    document.getElementById('ac-map-north-preset')?.addEventListener('change', (e) => {
        const v = /** @type {HTMLSelectElement} */ (e.target).value;
        const custom = document.getElementById('ac-map-north-custom');
        if (custom) custom.style.display = v === 'custom' ? 'block' : 'none';
    });

    document.getElementById('ac-map-btn-save')?.addEventListener('click', () => {
        void saveMapDraft();
    });

    document.getElementById('ac-map-btn-spots')?.addEventListener('click', () => {
        void openSpotDefinitionModal();
    });

    document.getElementById('ac-map-spot-close')?.addEventListener('click', () => {
        closeSpotModal();
    });

    document.getElementById('ac-map-spot-delete')?.addEventListener('click', () => {
        if (!selectedSpotId || !draftMap?.config?.spots) return;
        draftMap.config.spots = draftMap.config.spots.filter((s) => s.id !== selectedSpotId);
        selectedSpotId = null;
        syncMapFormFromDraft(draftMap);
        setMapStatus('スポットを削除しました');
    });

    document.getElementById('ac-map-spot-rename')?.addEventListener('click', () => {
        if (!selectedSpotId || !draftMap?.config?.spots) return;
        const spot = draftMap.config.spots.find((s) => s.id === selectedSpotId);
        if (!spot) return;
        const name = window.prompt('スポット名', spot.name);
        if (name == null || !name.trim()) return;
        spot.name = name.trim();
        syncMapFormFromDraft(draftMap);
    });

    void reloadWorldSelect();
}

/**
 * Map定義タブ表示時にワールド一覧を再読込する
 */
export function refreshAircraftMapAdminPanel() {
    if (!mapMounted) return;
    void reloadWorldSelect();
}
