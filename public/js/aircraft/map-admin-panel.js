// public/js/aircraft/map-admin-panel.js — 飛行ミニマップ「Map定義」管理 UI

import { AdminMapSpotWorkbench } from './map-admin-spot-workbench.js';
import { fetchGoogleMapsApiKey } from './map-admin-google-preview.js';
import {
    MIN_GEO_CALIBRATION_SPOTS,
    countGeoCalibratedSpots,
    computeGeoCalibrationFromSpots,
    spotHasGeo,
    isGeoMapReady,
    projectSpotsGeoFromWorld,
    projectSpotGeoFromWorld,
} from './flight-map-geo.js';

/** @type {boolean} */
let mapMounted = false;
/** @type {string|null} */
let selectedWorldId = null;
/** @type {object|null} */
let draftMap = null;
/** @type {string|null} */
let selectedSpotId = null;
/** @type {AdminMapSpotWorkbench|null} */
let spotWorkbench = null;
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

/** @type {Record<string, string>} */
const CALIBRATION_ERROR_JA = {
    geo_calibration_needs_3_spots: `地図座標付きスポットが ${MIN_GEO_CALIBRATION_SPOTS} つ以上必要です`,
    geo_calibration_spots_collinear: 'スポットが一直線上です。離れた位置に置き直してください',
    geo_calibration_solve_failed: '補正の計算に失敗しました',
    geo_calibration_invalid_scale: '算出された縮尺が不正です',
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
 * 補正ステータス表示を更新する
 * @param {object} [calibrationResult]
 */
function updateCalibrationStatus(calibrationResult) {
    const el = document.getElementById('ac-map-geo-calibration-status');
    if (!el) return;
    const spots = draftMap?.config?.spots || [];
    const n = countGeoCalibratedSpots(spots);
    const enabled =
        /** @type {HTMLInputElement|null} */ (document.getElementById('ac-map-geo-enabled'))
            ?.checked === true;
    if (!enabled) {
        el.textContent = '';
        return;
    }
    if (n < MIN_GEO_CALIBRATION_SPOTS) {
        el.textContent = `地図座標付きスポット: ${n} / ${MIN_GEO_CALIBRATION_SPOTS}（あと ${MIN_GEO_CALIBRATION_SPOTS - n} つ必要）`;
        el.style.color = '#c62828';
        return;
    }
    if (calibrationResult?.ok) {
        el.textContent =
            `補正 OK — ${calibrationResult.spotCount} 点、平均誤差 ${calibrationResult.residualM.toFixed(1)} m`;
        el.style.color = '#2e7d32';
        return;
    }
    el.textContent = `地図座標付きスポット: ${n} 点 — 「補正を計算」を実行してください`;
    el.style.color = '';
}

/**
 * スポット 3 点以上から geo を算出して draft に反映する
 * @param {boolean} [showError]
 * @param {{ preserveMapView?: boolean }} [opts]
 * @returns {boolean}
 */
function tryApplyGeoCalibration(showError = false, opts = {}) {
    const cfg = readConfigFromForm();
    if (!cfg.geo.enabled) {
        updateCalibrationStatus();
        return false;
    }
    const result = computeGeoCalibrationFromSpots(cfg.spots, cfg.northDirection, cfg.geo);
    if (!result.ok) {
        updateCalibrationStatus();
        if (showError) {
            setMapStatus(CALIBRATION_ERROR_JA[result.error] || result.error, true);
        }
        return false;
    }
    if (!draftMap) draftMap = { worldId: selectedWorldId, config: defaultMapConfig() };
    const geoWithView = opts.preserveMapView
        ? preserveMapViewFromGeo(result.geo, cfg.geo)
        : applyMapViewAfterCalibration(result.geo, cfg.spots);
    draftMap.config = {
        ...cfg,
        geo: geoWithView,
        spots: projectSpotsGeoFromWorld(cfg.spots, result.geo, cfg.northDirection, {
            preserveManualGeo: true,
        }),
    };
    syncGeoComputedPanel(geoWithView);
    updateCalibrationStatus(result);
    refreshWorkbench();
    if (!opts.preserveMapView) {
        spotWorkbench?.applySavedMapView(geoWithView);
    }
    return true;
}

/**
 * 補正パラメータを更新しつつ、地図のパン・回転・ズームは維持する
 * @param {object} newGeo
 * @param {object|null|undefined} prevGeo
 * @returns {object}
 */
function preserveMapViewFromGeo(newGeo, prevGeo) {
    if (!prevGeo || typeof prevGeo !== 'object') return newGeo;
    const out = { ...newGeo };
    if (typeof prevGeo.overlayCenterLat === 'number') out.overlayCenterLat = prevGeo.overlayCenterLat;
    if (typeof prevGeo.overlayCenterLng === 'number') out.overlayCenterLng = prevGeo.overlayCenterLng;
    if (typeof prevGeo.overlayZoom === 'number') out.overlayZoom = prevGeo.overlayZoom;
    if (typeof prevGeo.overlayHeading === 'number') out.overlayHeading = prevGeo.overlayHeading;
    return out;
}

/**
 * 補正後: 手動地点は維持し、地図ビューの向き（heading）で整合させる
 * @param {object} geo
 * @param {object[]} spots
 * @returns {object}
 */
function applyMapViewAfterCalibration(geo, spots) {
    const out = { ...geo };
    const manual = spots.filter((s) => spotHasGeo(s));
    if (manual.length >= 1) {
        let sumLat = 0;
        let sumLng = 0;
        for (const s of manual) {
            sumLat += s.lat;
            sumLng += s.lng;
        }
        out.overlayCenterLat = sumLat / manual.length;
        out.overlayCenterLng = sumLng / manual.length;
    }
    if (typeof out.geoNorthOffsetDeg === 'number' && Number.isFinite(out.geoNorthOffsetDeg)) {
        out.overlayHeading = out.geoNorthOffsetDeg;
    }
    return out;
}

/**
 * 算出済み geo パラメータを読み取り専用パネルへ表示する
 * @param {object|null|undefined} geo
 */
function syncGeoComputedPanel(geo) {
    const panel = document.getElementById('ac-map-geo-computed');
    if (!panel) return;
    if (!geo?.anchorLat || !geo?.anchorLng) {
        panel.hidden = true;
        return;
    }
    panel.hidden = false;
    panel.innerHTML =
        `<p class="hint">手動の地図座標は維持されます。向きは地図回転（heading）で合わせます。</p>`
        + `<dl class="ac-map-geo-computed-dl">`
        + `<dt>基準 World</dt><dd>X=${geo.anchorWorldX?.toFixed(1)} Z=${geo.anchorWorldZ?.toFixed(1)}</dd>`
        + `<dt>基準 緯度経度</dt><dd>${geo.anchorLat?.toFixed(6)}, ${geo.anchorLng?.toFixed(6)}</dd>`
        + `<dt>縮尺</dt><dd>${geo.metersPerWorldUnit?.toFixed(4)} m / 単位</dd>`
        + `<dt>北向き補正</dt><dd>${geo.geoNorthOffsetDeg?.toFixed(2)}°</dd>`
        + `</dl>`;
}

/**
 * フォームから geo 表示設定を読む（幾何パラメータは補正結果を draft から引き継ぐ）
 * @returns {object}
 */
function readGeoFromForm() {
    const enabled = /** @type {HTMLInputElement|null} */ (
        document.getElementById('ac-map-geo-enabled')
    )?.checked === true;
    const mapType =
        /** @type {HTMLSelectElement|null} */ (document.getElementById('ac-map-geo-map-type'))
            ?.value || 'satellite';
    const base = draftMap?.config?.geo || defaultMapConfig().geo;
    return {
        enabled,
        anchorWorldX: base.anchorWorldX ?? 0,
        anchorWorldZ: base.anchorWorldZ ?? 0,
        anchorLat: base.anchorLat ?? null,
        anchorLng: base.anchorLng ?? null,
        metersPerWorldUnit: base.metersPerWorldUnit ?? 1,
        geoNorthOffsetDeg: base.geoNorthOffsetDeg ?? 0,
        mapType,
        zoom: base.zoom ?? 15,
        zoomOffset: base.zoomOffset ?? 0,
        headingMode: base.headingMode ?? 'trackUp',
        overlayCenterLat: base.overlayCenterLat ?? null,
        overlayCenterLng: base.overlayCenterLng ?? null,
        overlayZoom: base.overlayZoom ?? null,
        overlayHeading: base.overlayHeading ?? 0,
        calibrationSpotCount: base.calibrationSpotCount,
        calibrationResidualM: base.calibrationResidualM,
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
    const mapTypeEl = /** @type {HTMLSelectElement|null} */ (
        document.getElementById('ac-map-geo-map-type')
    );
    if (mapTypeEl) mapTypeEl.value = g.mapType || 'satellite';
    const geoPanel = document.getElementById('ac-map-geo-fields');
    if (geoPanel) geoPanel.style.display = g.enabled ? 'block' : 'none';
    syncGeoComputedPanel(g);
    updateCalibrationStatus(
        g.calibrationSpotCount >= MIN_GEO_CALIBRATION_SPOTS
            ? { ok: true, spotCount: g.calibrationSpotCount, residualM: g.calibrationResidualM || 0 }
            : undefined
    );
}

/**
 * ワークベンチ（メタバース / Google / 統合）を更新する
 */
function refreshWorkbench() {
    if (!spotWorkbench) return;
    const cfg = readConfigFromForm();
    spotWorkbench.setConfig(cfg);
    spotWorkbench.setSelectedSpotId(selectedSpotId);
    const geoOn = cfg.geo?.enabled === true;
    const spotCount = cfg.spots?.length || 0;
    spotWorkbench.setGoogleTabEnabled(geoOn, { spotCount, silent: true });
}

/**
 * 補正済みなら、メタバースで動かした1点だけ lat/lng を再投影する
 * @param {object} cfg
 * @param {string} spotId
 * @returns {object}
 */
function applyAutoGeoProjectionForSpot(cfg, spotId) {
    if (!isGeoMapReady(cfg.geo) || !spotId) return cfg;
    const spots = cfg.spots.map((s) =>
        s.id === spotId ? projectSpotGeoFromWorld(s, cfg.geo, cfg.northDirection) : s
    );
    return { ...cfg, spots };
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
    setNum('ac-map-aircraft-icon-offset', cfg.aircraftIconOffsetDeg ?? 0);
    syncGeoForm(cfg.geo);
    renderSpotList();
    maybeDisableGoogleTabIfNeeded();
    refreshWorkbench();
}

/**
 * スポット不足時に Google タブをオフにする
 */
function maybeDisableGoogleTabIfNeeded() {
    const spots = draftMap?.config?.spots?.length || 0;
    if (spots >= MIN_GEO_CALIBRATION_SPOTS || !draftMap?.config?.geo?.enabled) return;
    draftMap.config.geo.enabled = false;
    const enabledEl = /** @type {HTMLInputElement|null} */ (
        document.getElementById('ac-map-geo-enabled')
    );
    if (enabledEl) enabledEl.checked = false;
    const panel = document.getElementById('ac-map-geo-fields');
    if (panel) panel.style.display = 'none';
    spotWorkbench?.setGoogleTabEnabled(false, { spotCount: spots });
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
    const base = draftMap?.config || defaultMapConfig();
    return {
        northDirection: readNorthFromForm(),
        cameraHeightM: num('ac-map-camera-height', 500),
        groundRefY: base.groundRefY ?? 0,
        aircraftIconOffsetDeg: Math.max(
            -180,
            Math.min(180, num('ac-map-aircraft-icon-offset', base.aircraftIconOffsetDeg ?? 0))
        ),
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
        list.innerHTML = '<p class="hint">メタバース表示でクリックして追加、または「スポット追加」</p>';
        return;
    }
    list.innerHTML = spots
        .map((s) => {
            const geoLine = spotHasGeo(s)
                ? `地図: ${s.lat?.toFixed(5)}, ${s.lng?.toFixed(5)}`
                : '地図: 未設定（Google タブでクリック）';
            return (
                `<button type="button" class="ac-map-spot-item${s.id === selectedSpotId ? ' is-selected' : ''}" data-spot-id="${s.id}">`
                + `<span class="ac-map-spot-name">${escapeHtml(s.name)}</span>`
                + `<span class="ac-map-spot-coord">メタバース X=${s.x.toFixed(1)} Z=${s.z.toFixed(1)}</span>`
                + `<span class="ac-map-spot-geo${spotHasGeo(s) ? ' is-set' : ''}">${escapeHtml(geoLine)}</span>`
                + `</button>`
            );
        })
        .join('');
    list.querySelectorAll('[data-spot-id]').forEach((btn) => {
        btn.addEventListener('click', () => {
            selectedSpotId = btn.getAttribute('data-spot-id');
            renderSpotList();
            spotWorkbench?.setSelectedSpotId(selectedSpotId);
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
 * 選択ワールドをワークベンチへ読み込む
 */
async function loadWorkbenchWorld() {
    if (!selectedWorldId || !spotWorkbench || !worldsCache) return;
    const world = worldsCache[selectedWorldId];
    if (!world) return;
    const worldId = selectedWorldId;
    await spotWorkbench.loadWorldFromCache(worldId, world);
}

/**
 * メタバース上のクリックでスポット XZ を更新または追加する
 * @param {number} x
 * @param {number} z
 */
function handleSpotWorldPick(x, z) {
    if (spotWorkbench?.getActiveViewTab() !== 'metaverse') return;
    const nextCfg = readConfigFromForm();
    if (selectedSpotId) {
        const spot = nextCfg.spots.find((s) => s.id === selectedSpotId);
        if (!spot) return;
        spot.x = x;
        spot.z = z;
        if (!draftMap) draftMap = { worldId: selectedWorldId, config: defaultMapConfig() };
        draftMap.config = applyAutoGeoProjectionForSpot(nextCfg, selectedSpotId);
        syncMapFormFromDraft(draftMap);
        setMapStatus(`${spot.name}: X=${x.toFixed(1)} Z=${z.toFixed(1)}`);
        return;
    }
    const name = window.prompt('スポット名', `スポット ${nextCfg.spots.length + 1}`);
    if (name == null || !name.trim()) return;
    const id = nextSpotId();
    nextCfg.spots.push({ id, name: name.trim(), x, z });
    if (!draftMap) draftMap = { worldId: selectedWorldId, config: defaultMapConfig() };
    draftMap.config = applyAutoGeoProjectionForSpot(nextCfg, id);
    selectedSpotId = id;
    syncMapFormFromDraft(draftMap);
    setMapStatus(`スポット追加: ${name.trim()} (X=${x.toFixed(1)}, Z=${z.toFixed(1)})`);
}

/**
 * スポットの地図座標を更新する（クリック配置・ドラッグ共通）
 * @param {string} spotId
 * @param {number} lat
 * @param {number} lng
 * @param {{ select?: boolean }} [opts]
 */
function updateSpotGeo(spotId, lat, lng, opts = {}) {
    if (spotWorkbench?.getActiveViewTab() !== 'google') return;
    const nextCfg = readConfigFromForm();
    const spot = nextCfg.spots.find((s) => s.id === spotId);
    if (!spot) return;
    spot.lat = lat;
    spot.lng = lng;
    if (!draftMap) draftMap = { worldId: selectedWorldId, config: defaultMapConfig() };
    draftMap.config = nextCfg;
    if (opts.select !== false && selectedSpotId !== spotId) {
        selectedSpotId = spotId;
        spotWorkbench?.setSelectedSpotId(selectedSpotId);
    }
    renderSpotList();
    setMapStatus(`${spot.name}: 地図 ${lat.toFixed(6)}, ${lng.toFixed(6)}`);
    if (countGeoCalibratedSpots(draftMap.config.spots) >= MIN_GEO_CALIBRATION_SPOTS) {
        tryApplyGeoCalibration(false, { preserveMapView: true });
    } else {
        updateCalibrationStatus();
        refreshWorkbench();
    }
}

/**
 * Google Map 上のクリックで選択スポットの緯度経度を設定する
 * @param {number} lat
 * @param {number} lng
 */
function handleSpotGeoPick(lat, lng) {
    if (!selectedSpotId || !draftMap?.config?.spots) {
        setMapStatus('スポットを一覧で選択し、地図上をクリックしてください', true);
        return;
    }
    updateSpotGeo(selectedSpotId, lat, lng, { select: false });
}

/**
 * Google Map 上でマーカーをドラッグしてスポット位置を調整する
 * @param {string} spotId
 * @param {number} lat
 * @param {number} lng
 */
function handleSpotGeoMove(spotId, lat, lng) {
    updateSpotGeo(spotId, lat, lng);
}

/**
 * Google Map 上のマーカークリックでスポットを選択する
 * @param {string} spotId
 */
function handleSpotSelect(spotId) {
    selectedSpotId = spotId;
    renderSpotList();
    spotWorkbench?.setSelectedSpotId(selectedSpotId);
}

/**
 * 地図オーバーレイのパン・回転・ズームを draft に保存する
 * @param {object} view
 */
function handleMapViewChange(view) {
    if (!draftMap?.config) return;
    const geo = { ...readGeoFromForm(), ...view };
    draftMap.config = { ...readConfigFromForm(), geo };
}

/**
 * Google Map 有効チェックの状態を反映する
 * @param {boolean} enabled
 */
function syncGoogleTabFromForm(enabled) {
    const cfg = readConfigFromForm();
    const spotCount = cfg.spots?.length || 0;
    if (enabled && spotCount < MIN_GEO_CALIBRATION_SPOTS) {
        const enabledEl = /** @type {HTMLInputElement|null} */ (
            document.getElementById('ac-map-geo-enabled')
        );
        if (enabledEl) enabledEl.checked = false;
        setMapStatus(
            `Google Map にはスポットが ${MIN_GEO_CALIBRATION_SPOTS} 点以上必要です`,
            true
        );
        spotWorkbench?.setGoogleTabEnabled(false, { spotCount });
        return;
    }
    if (!draftMap) draftMap = { worldId: selectedWorldId, config: defaultMapConfig() };
    draftMap.config = { ...cfg, geo: { ...cfg.geo, enabled } };
    spotWorkbench?.setGoogleTabEnabled(enabled, { spotCount });
    if (enabled) {
        setMapStatus('Google タブで先頭3点の地図座標を設定し、「補正を計算」を実行してください');
    }
    updateCalibrationStatus();
}

/**
 * @param {string} worldId
 */
async function selectWorld(worldId) {
    spotWorkbench?.cancelWorldLoad();
    const requestedId = worldId;
    selectedWorldId = worldId;
    selectedSpotId = null;
    const sel = /** @type {HTMLSelectElement|null} */ (document.getElementById('ac-map-world-select'));
    if (sel) sel.value = worldId;
    try {
        const j = await fetchJson(`/admin/addons/aircraft/flight-maps/${encodeURIComponent(worldId)}`);
        if (selectedWorldId !== requestedId) return;
        draftMap = j.map || {
            worldId,
            config: defaultMapConfig(),
        };
        syncMapFormFromDraft(draftMap);
        setMapStatus('');
        if (selectedWorldId !== requestedId) return;
        await loadWorkbenchWorld();
    } catch (e) {
        if (selectedWorldId !== requestedId) return;
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
    if (config.geo.enabled) {
        const result = computeGeoCalibrationFromSpots(
            config.spots,
            config.northDirection,
            config.geo
        );
        if (!result.ok) {
            setMapStatus(CALIBRATION_ERROR_JA[result.error] || result.error, true);
            return;
        }
        config.geo = preserveMapViewFromGeo(
            applyMapViewAfterCalibration(result.geo, config.spots),
            readGeoFromForm()
        );
        config.spots = projectSpotsGeoFromWorld(
            config.spots,
            result.geo,
            config.northDirection,
            { preserveManualGeo: true }
        );
    }
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
 * 新規スポットを一覧に追加する（座標は後からクリックで設定）
 */
function addSpotFromButton() {
    const name = window.prompt('スポット名', 'スポット');
    if (name == null || !name.trim()) return;
    const nextCfg = readConfigFromForm();
    const id = nextSpotId();
    const spots = nextCfg.spots;
    let x = 0;
    let z = 0;
    if (spots.length) {
        x = spots.reduce((s, p) => s + p.x, 0) / spots.length;
        z = spots.reduce((s, p) => s + p.z, 0) / spots.length;
    }
    nextCfg.spots.push({ id, name: name.trim(), x, z });
    if (!draftMap) draftMap = { worldId: selectedWorldId, config: defaultMapConfig() };
    draftMap.config = nextCfg;
    selectedSpotId = id;
    syncMapFormFromDraft(draftMap);
    setMapStatus(`スポット追加: ${name.trim()} — メタバース表示で位置をクリック`);
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
            <section class="ac-map-admin-center ac-map-admin-center-workbench">
                <div id="ac-map-workbench-mount" class="ac-map-workbench-mount"></div>
            </section>
            <aside class="ac-map-admin-right ac-map-settings-panel">
                <h2 class="section-title">map設定</h2>
                <p class="hint">①メタバースで3点以上配置 → ②Google 有効 → ③Google タブで地図座標 → ④補正</p>
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
                    <input type="number" id="ac-map-camera-height" class="prop-input num" step="25" min="50" title="俯瞰の見える範囲" /></div>
                <div class="field-row">
                    <label class="prop-label" for="ac-map-aircraft-icon-offset">プレイヤーアイコン向き補正 (°)</label>
                    <input type="number" id="ac-map-aircraft-icon-offset" class="prop-input num" step="1" min="-180" max="180" value="0"
                        title="飛行方向とミニマップ矢印のずれを補正（時計回りが＋）" />
                </div>
                <p class="hint ac-map-icon-offset-hint">操縦中の矢印が進行方向とずれる場合に調整。保存後に飛行テストしてください。</p>
                <div class="prop-group-label">Google Maps 2D</div>
                <div class="field-row">
                    <label class="prop-label" for="ac-map-geo-enabled">Google Map 有効</label>
                    <input type="checkbox" id="ac-map-geo-enabled" class="prop-input" title="スポット3点以上で利用可能" />
                </div>
                <p id="ac-map-geo-calibration-status" class="status-text" role="status"></p>
                <div id="ac-map-geo-fields">
                    <div class="field-row"><label class="prop-label" for="ac-map-geo-map-type">地図タイプ</label>
                        <select id="ac-map-geo-map-type" class="prop-input full">
                            <option value="satellite">衛星</option>
                            <option value="roadmap">道路</option>
                            <option value="hybrid">ハイブリッド</option>
                            <option value="terrain">地形</option>
                        </select></div>
                    <div id="ac-map-geo-computed" class="ac-map-geo-computed" hidden></div>
                    <div class="ac-admin-actions">
                        <button type="button" class="btn btn-secondary" id="ac-map-btn-calibrate">補正を計算</button>
                        <button type="button" class="btn btn-sm btn-outline-secondary" id="ac-map-spot-clear-geo">選択の地図座標クリア</button>
                    </div>
                </div>
                <div class="prop-group-label">スポット一覧</div>
                <div class="ac-admin-actions">
                    <button type="button" class="btn btn-secondary btn-sm" id="ac-map-btn-spot-add">スポット追加</button>
                    <button type="button" class="btn btn-sm btn-outline-secondary" id="ac-map-spot-rename">名前変更</button>
                    <button type="button" class="btn btn-sm btn-outline-secondary" id="ac-map-spot-delete">削除</button>
                </div>
                <div id="ac-map-spot-list" class="ac-map-spot-list"></div>
                <div class="ac-admin-actions" style="margin-top:12px">
                    <button type="button" class="btn btn-primary" id="ac-map-btn-save">保存</button>
                </div>
                <p id="ac-map-status" class="status-text" role="status"></p>
            </aside>
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
        refreshWorkbench();
    });

    const previewOnChange = () => {
        refreshWorkbench();
        if (document.getElementById('ac-map-geo-enabled')?.checked) {
            tryApplyGeoCalibration(false);
        }
    };
    for (const id of ['ac-map-camera-height', 'ac-map-north-x', 'ac-map-north-z', 'ac-map-aircraft-icon-offset']) {
        document.getElementById(id)?.addEventListener('input', previewOnChange);
    }
    document.getElementById('ac-map-geo-map-type')?.addEventListener('change', previewOnChange);

    document.getElementById('ac-map-geo-enabled')?.addEventListener('change', (e) => {
        const checked = /** @type {HTMLInputElement} */ (e.target).checked;
        const panel = document.getElementById('ac-map-geo-fields');
        if (panel) panel.style.display = checked ? 'block' : 'none';
        syncGoogleTabFromForm(checked);
        refreshWorkbench();
    });

    const workbenchMount = document.getElementById('ac-map-workbench-mount');
    if (workbenchMount) {
        spotWorkbench = new AdminMapSpotWorkbench(workbenchMount);
        spotWorkbench.onSpotWorldPick = handleSpotWorldPick;
        spotWorkbench.onSpotGeoPick = handleSpotGeoPick;
        spotWorkbench.onSpotGeoMove = handleSpotGeoMove;
        spotWorkbench.onSpotSelect = handleSpotSelect;
        spotWorkbench.onMapViewChange = handleMapViewChange;
        void fetchGoogleMapsApiKey().then((key) => {
            googleMapsApiKey = key;
            spotWorkbench?.setApiKey(key);
            refreshWorkbench();
        });
    }

    document.getElementById('ac-map-btn-calibrate')?.addEventListener('click', () => {
        if (tryApplyGeoCalibration(true)) {
            setMapStatus('補正完了 — 地図上の選択位置はそのまま、向きを合わせました');
        }
    });

    document.getElementById('ac-map-spot-clear-geo')?.addEventListener('click', () => {
        if (!selectedSpotId || !draftMap?.config?.spots) return;
        const spot = draftMap.config.spots.find((s) => s.id === selectedSpotId);
        if (!spot) return;
        delete spot.lat;
        delete spot.lng;
        syncMapFormFromDraft(draftMap);
        setMapStatus(`${spot.name} の地図座標をクリアしました`);
    });

    document.getElementById('ac-map-btn-save')?.addEventListener('click', () => {
        void saveMapDraft();
    });

    document.getElementById('ac-map-btn-spot-add')?.addEventListener('click', () => {
        addSpotFromButton();
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
