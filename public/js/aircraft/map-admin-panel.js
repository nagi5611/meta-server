// public/js/aircraft/map-admin-panel.js — 飛行ミニマップ「Map定義」管理 UI

import { AdminMapSpotWorldViewer } from './map-spot-world-viewer.js';
import { AdminMapGooglePreview, fetchGoogleMapsApiKey } from './map-admin-google-preview.js';

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
/** @type {AdminMapGooglePreview|null} */
let googlePreview = null;
/** @type {string|null} */
let googleMapsApiKey = null;
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
        cameraHeightM: 500,
        groundRefY: 0,
        aircraftIconOffsetDeg: 0,
        spots: [],
        geo: {
            enabled: false,
            anchorWorldX: 0,
            anchorWorldZ: 0,
            anchorLat: null,
            anchorLng: null,
            metersPerWorldUnit: 1,
            geoNorthOffsetDeg: 0,
            mapType: 'satellite',
            zoom: 15,
            zoomOffset: 0,
            headingMode: 'trackUp',
        },
    };
}

/**
 * フォームから geo 設定を読む
 * @returns {object}
 */
function readGeoFromForm() {
    const num = (id, fallback) => {
        const el = /** @type {HTMLInputElement|null} */ (document.getElementById(id));
        const v = el ? Number(el.value) : NaN;
        return Number.isFinite(v) ? v : fallback;
    };
    const enabled = /** @type {HTMLInputElement|null} */ (
        document.getElementById('ac-map-geo-enabled')
    )?.checked === true;
    const anchorLatRaw = num('ac-map-geo-anchor-lat', NaN);
    const anchorLngRaw = num('ac-map-geo-anchor-lng', NaN);
    const mapType =
        /** @type {HTMLSelectElement|null} */ (document.getElementById('ac-map-geo-map-type'))
            ?.value || 'satellite';
    const headingMode =
        /** @type {HTMLSelectElement|null} */ (document.getElementById('ac-map-geo-heading-mode'))
            ?.value || 'trackUp';
    return {
        enabled,
        anchorWorldX: num('ac-map-geo-anchor-world-x', 0),
        anchorWorldZ: num('ac-map-geo-anchor-world-z', 0),
        anchorLat: Number.isFinite(anchorLatRaw) ? anchorLatRaw : null,
        anchorLng: Number.isFinite(anchorLngRaw) ? anchorLngRaw : null,
        metersPerWorldUnit: Math.max(0.001, num('ac-map-geo-meters-per-unit', 1)),
        geoNorthOffsetDeg: num('ac-map-geo-north-offset', 0),
        mapType,
        zoom: Math.round(num('ac-map-geo-zoom', 15)),
        zoomOffset: Math.round(num('ac-map-geo-zoom-offset', 0)),
        headingMode,
    };
}

/**
 * geo 設定をフォームへ反映する
 * @param {object|null|undefined} geo
 */
function syncGeoForm(geo) {
    const g = geo || defaultMapConfig().geo;
    const setNum = (id, v) => {
        const el = /** @type {HTMLInputElement|null} */ (document.getElementById(id));
        if (el) el.value = v != null && Number.isFinite(v) ? String(v) : '';
    };
    const enabledEl = /** @type {HTMLInputElement|null} */ (
        document.getElementById('ac-map-geo-enabled')
    );
    if (enabledEl) enabledEl.checked = g.enabled === true;
    setNum('ac-map-geo-anchor-world-x', g.anchorWorldX ?? 0);
    setNum('ac-map-geo-anchor-world-z', g.anchorWorldZ ?? 0);
    setNum('ac-map-geo-anchor-lat', g.anchorLat);
    setNum('ac-map-geo-anchor-lng', g.anchorLng);
    setNum('ac-map-geo-meters-per-unit', g.metersPerWorldUnit ?? 1);
    setNum('ac-map-geo-north-offset', g.geoNorthOffsetDeg ?? 0);
    setNum('ac-map-geo-zoom', g.zoom ?? 15);
    setNum('ac-map-geo-zoom-offset', g.zoomOffset ?? 0);
    const mapTypeEl = /** @type {HTMLSelectElement|null} */ (
        document.getElementById('ac-map-geo-map-type')
    );
    if (mapTypeEl) mapTypeEl.value = g.mapType || 'satellite';
    const headingEl = /** @type {HTMLSelectElement|null} */ (
        document.getElementById('ac-map-geo-heading-mode')
    );
    if (headingEl) headingEl.value = g.headingMode || 'trackUp';
    const geoPanel = document.getElementById('ac-map-geo-fields');
    if (geoPanel) geoPanel.style.display = g.enabled ? 'block' : 'none';
}

/**
 * Google Maps プレビューを更新する
 */
function refreshGooglePreview() {
    if (!googlePreview) return;
    const cfg = readConfigFromForm();
    googlePreview.setConfig(cfg);
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
    setNum('ac-map-camera-height', cfg.cameraHeightM ?? 500);
    setNum('ac-map-ground-y', cfg.groundRefY ?? 0);
    setNum('ac-map-icon-offset', cfg.aircraftIconOffsetDeg ?? 0);
    syncGeoForm(cfg.geo);
    renderSpotList();
    if (spotViewer) spotViewer.setSpotMarkers(cfg.spots || []);
    refreshGooglePreview();
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
        cameraHeightM: num('ac-map-camera-height', 500),
        groundRefY: num('ac-map-ground-y', 0),
        aircraftIconOffsetDeg: num('ac-map-icon-offset', 0),
        spots: draftMap?.config?.spots ? [...draftMap.config.spots] : [],
        geo: readGeoFromForm(),
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
    if (!worldsCache) {
        try {
            worldsCache = await fetchJson('/admin/worlds');
        } catch {
            worldsCache = {};
        }
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
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const cfg = readConfigFromForm();
    spotViewer = new AdminMapSpotWorldViewer(mount);
    spotViewer.setViewOptions({
        cameraHeightM: cfg.cameraHeightM,
        groundRefY: cfg.groundRefY,
        northDirection: cfg.northDirection,
    });
    spotViewer.setSpotMarkers(cfg.spots || []);
    spotViewer.onSpotPick = (x, z) => {
        const name = window.prompt('スポット名', 'スポット');
        if (name == null || !name.trim()) return;
        const nextCfg = readConfigFromForm();
        const id = nextSpotId();
        nextCfg.spots.push({
            id,
            name: name.trim(),
            x,
            z,
        });
        if (!draftMap) draftMap = { worldId: selectedWorldId, config: defaultMapConfig() };
        draftMap.config = nextCfg;
        selectedSpotId = id;
        syncMapFormFromDraft(draftMap);
        spotViewer?.setSpotMarkers(nextCfg.spots);
        setMapStatus(`スポット追加: ${name.trim()} (X=${x.toFixed(1)}, Z=${z.toFixed(1)})`);
    };
    try {
        const { loaded, total } = await spotViewer.loadWorld(world);
        spotViewer.setSpotMarkers(readConfigFromForm().spots || []);
        setMapStatus(
            `クリックでスポット追加（モデル ${loaded}/${total} 件読込・ドラッグで移動）`
        );
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
                <p class="hint">ミニマップは<strong>3D俯瞰</strong>、<strong>M キー</strong>で Google Maps 2D を表示。縮尺・向きは下のジオリファレンスで調整します。</p>
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
                <div class="field-row"><label class="prop-label" for="ac-map-camera-height">カメラ高度 (m)</label>
                    <input type="number" id="ac-map-camera-height" class="prop-input num" step="25" min="50" title="地面（基準Y）からの高さ。大きいほど広い範囲が見えます" /></div>
                <div class="field-row"><label class="prop-label" for="ac-map-ground-y">地面基準 Y</label>
                    <input type="number" id="ac-map-ground-y" class="prop-input num" step="any" title="俯瞰カメラの注視点の高さ（通常は 0 またはスポーン付近）" /></div>
                <div class="field-row"><label class="prop-label" for="ac-map-icon-offset">機体アイコン向き補正 (°)</label>
                    <input type="number" id="ac-map-icon-offset" class="prop-input num" step="1" /></div>
                <div class="prop-group-label">Google Maps ジオリファレンス（M キー 2D マップ）</div>
                <div class="field-row">
                    <label class="prop-label" for="ac-map-geo-enabled">Google Maps 2D を有効</label>
                    <input type="checkbox" id="ac-map-geo-enabled" class="prop-input" />
                </div>
                <div id="ac-map-geo-fields">
                    <p class="hint">アンカー: ワールド座標と緯度経度の対応点。右プレビューをクリックで緯度経度を設定。</p>
                    <div class="field-row"><label class="prop-label" for="ac-map-geo-anchor-world-x">アンカー World X</label>
                        <input type="number" id="ac-map-geo-anchor-world-x" class="prop-input num" step="any" value="0" /></div>
                    <div class="field-row"><label class="prop-label" for="ac-map-geo-anchor-world-z">アンカー World Z</label>
                        <input type="number" id="ac-map-geo-anchor-world-z" class="prop-input num" step="any" value="0" /></div>
                    <div class="field-row"><label class="prop-label" for="ac-map-geo-anchor-lat">アンカー 緯度</label>
                        <input type="number" id="ac-map-geo-anchor-lat" class="prop-input num" step="any" /></div>
                    <div class="field-row"><label class="prop-label" for="ac-map-geo-anchor-lng">アンカー 経度</label>
                        <input type="number" id="ac-map-geo-anchor-lng" class="prop-input num" step="any" /></div>
                    <div class="field-row"><label class="prop-label" for="ac-map-geo-meters-per-unit">縮尺 (m / ワールド単位)</label>
                        <input type="number" id="ac-map-geo-meters-per-unit" class="prop-input num" step="any" min="0.001" value="1" title="1 ワールド単位が何メートルか" /></div>
                    <div class="field-row"><label class="prop-label" for="ac-map-geo-north-offset">北向き補正 (°)</label>
                        <input type="number" id="ac-map-geo-north-offset" class="prop-input num" step="0.1" title="ゲーム北と地理北のずれ。プレビューの黄線で確認" /></div>
                    <div class="field-row"><label class="prop-label" for="ac-map-geo-map-type">地図タイプ</label>
                        <select id="ac-map-geo-map-type" class="prop-input full">
                            <option value="satellite">衛星</option>
                            <option value="roadmap">道路</option>
                            <option value="hybrid">ハイブリッド</option>
                            <option value="terrain">地形</option>
                        </select></div>
                    <div class="field-row"><label class="prop-label" for="ac-map-geo-zoom">ズーム</label>
                        <input type="number" id="ac-map-geo-zoom" class="prop-input num" min="1" max="22" step="1" value="15" /></div>
                    <div class="field-row"><label class="prop-label" for="ac-map-geo-zoom-offset">ズーム微調整</label>
                        <input type="number" id="ac-map-geo-zoom-offset" class="prop-input num" min="-8" max="8" step="1" value="0" /></div>
                    <div class="field-row"><label class="prop-label" for="ac-map-geo-heading-mode">マップ回転</label>
                        <select id="ac-map-geo-heading-mode" class="prop-input full">
                            <option value="trackUp">機首上（track-up）</option>
                            <option value="northUp">北固定（north-up）</option>
                        </select></div>
                </div>
                <div class="ac-admin-actions">
                    <button type="button" class="btn btn-secondary" id="ac-map-btn-spots">スポット定義</button>
                    <button type="button" class="btn btn-primary" id="ac-map-btn-save">保存</button>
                </div>
                <p id="ac-map-status" class="status-text" role="status"></p>
            </aside>
            <section class="ac-map-admin-center">
                <h3 class="section-subtitle">Google Maps プレビュー</h3>
                <p class="hint">赤 A = アンカー、黄線 = ゲーム北方向（200m）、橙 = スポット。クリックでアンカー緯度経度を設定。</p>
                <div id="ac-map-google-preview-mount" class="ac-map-google-preview-mount"></div>
            </section>
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
        refreshGooglePreview();
    });

    const previewOnChange = () => refreshGooglePreview();
    for (const id of [
        'ac-map-camera-height',
        'ac-map-ground-y',
        'ac-map-icon-offset',
        'ac-map-north-x',
        'ac-map-north-z',
        'ac-map-geo-anchor-world-x',
        'ac-map-geo-anchor-world-z',
        'ac-map-geo-anchor-lat',
        'ac-map-geo-anchor-lng',
        'ac-map-geo-meters-per-unit',
        'ac-map-geo-north-offset',
        'ac-map-geo-zoom',
        'ac-map-geo-zoom-offset',
    ]) {
        document.getElementById(id)?.addEventListener('input', previewOnChange);
    }
    document.getElementById('ac-map-geo-map-type')?.addEventListener('change', previewOnChange);
    document.getElementById('ac-map-geo-heading-mode')?.addEventListener('change', previewOnChange);

    document.getElementById('ac-map-geo-enabled')?.addEventListener('change', (e) => {
        const panel = document.getElementById('ac-map-geo-fields');
        if (panel) {
            panel.style.display = /** @type {HTMLInputElement} */ (e.target).checked ? 'block' : 'none';
        }
        refreshGooglePreview();
    });

    const previewMount = document.getElementById('ac-map-google-preview-mount');
    if (previewMount) {
        void fetchGoogleMapsApiKey().then((key) => {
            googleMapsApiKey = key;
            googlePreview = new AdminMapGooglePreview(previewMount);
            googlePreview.setApiKey(key);
            googlePreview.onAnchorPick = (lat, lng) => {
                const latEl = /** @type {HTMLInputElement|null} */ (
                    document.getElementById('ac-map-geo-anchor-lat')
                );
                const lngEl = /** @type {HTMLInputElement|null} */ (
                    document.getElementById('ac-map-geo-anchor-lng')
                );
                if (latEl) latEl.value = String(lat);
                if (lngEl) lngEl.value = String(lng);
                const enabledEl = /** @type {HTMLInputElement|null} */ (
                    document.getElementById('ac-map-geo-enabled')
                );
                if (enabledEl && !enabledEl.checked) {
                    enabledEl.checked = true;
                    const panel = document.getElementById('ac-map-geo-fields');
                    if (panel) panel.style.display = 'block';
                }
                refreshGooglePreview();
                setMapStatus(`アンカー緯度経度: ${lat.toFixed(6)}, ${lng.toFixed(6)}`);
            };
            refreshGooglePreview();
        });
    }

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
