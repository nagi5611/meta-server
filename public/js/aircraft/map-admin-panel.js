// public/js/aircraft/map-admin-panel.js — 飛行ミニマップ「Map定義」管理 UI

/** @type {boolean} */
let mapMounted = false;
/** @type {string|null} */
let selectedWorldId = null;
/** @type {object|null} */
let draftMap = null;
/** @type {HTMLImageElement|null} */
let mapPreviewImage = null;
/** @type {string|null} */
let selectedSpotId = null;

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
        worldBounds: { westX: -5000, eastX: 5000, northZ: -5000, southZ: 5000 },
        minimapRadiusM: 800,
        aircraftIconOffsetDeg: 0,
        spots: [],
    };
}

/**
 * @param {object|null|undefined} map
 */
function syncMapFormFromDraft(map) {
    draftMap = map;
    const cfg = map?.config || defaultMapConfig();
    const b = cfg.worldBounds || {};
    const setNum = (id, v) => {
        const el = /** @type {HTMLInputElement|null} */ (document.getElementById(id));
        if (el) el.value = String(v ?? '');
    };
    setNum('ac-map-west', b.westX);
    setNum('ac-map-east', b.eastX);
    setNum('ac-map-north', b.northZ);
    setNum('ac-map-south', b.southZ);
    setNum('ac-map-radius', cfg.minimapRadiusM ?? 800);
    setNum('ac-map-icon-offset', cfg.aircraftIconOffsetDeg ?? 0);

    const imgEl = /** @type {HTMLImageElement|null} */ (document.getElementById('ac-map-preview-img'));
    const canvas = /** @type {HTMLCanvasElement|null} */ (document.getElementById('ac-map-preview-canvas'));
    const url = map?.imageUrl || '';
    if (imgEl) {
        imgEl.src = url;
        imgEl.style.display = url ? 'block' : 'none';
    }
    if (canvas) canvas.style.display = url ? 'block' : 'none';
    mapPreviewImage = null;
    if (url && imgEl) {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => {
            mapPreviewImage = img;
            drawMapPreview();
        };
        img.src = url;
    } else {
        drawMapPreview();
    }
    renderSpotList();
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
        worldBounds: {
            westX: num('ac-map-west', -5000),
            eastX: num('ac-map-east', 5000),
            northZ: num('ac-map-north', -5000),
            southZ: num('ac-map-south', 5000),
        },
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
        list.innerHTML = '<p class="hint">地図をクリックしてスポットを追加</p>';
        return;
    }
    list.innerHTML = spots
        .map(
            (s) =>
                `<button type="button" class="ac-map-spot-item${s.id === selectedSpotId ? ' is-selected' : ''}" data-spot-id="${s.id}">` +
                `<span class="ac-map-spot-name">${escapeHtml(s.name)}</span>` +
                `<span class="ac-map-spot-coord">u=${s.u.toFixed(3)} v=${s.v.toFixed(3)}</span>` +
                `</button>`
        )
        .join('');
    list.querySelectorAll('[data-spot-id]').forEach((btn) => {
        btn.addEventListener('click', () => {
            selectedSpotId = btn.getAttribute('data-spot-id');
            renderSpotList();
            drawMapPreview();
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
 * 地図プレビュー（スポットマーカー付き）を描画する
 */
function drawMapPreview() {
    const canvas = /** @type {HTMLCanvasElement|null} */ (document.getElementById('ac-map-preview-canvas'));
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#1a1a22';
    ctx.fillRect(0, 0, w, h);

    if (mapPreviewImage && mapPreviewImage.complete && mapPreviewImage.naturalWidth > 0) {
        ctx.drawImage(mapPreviewImage, 0, 0, w, h);
    } else {
        ctx.fillStyle = 'rgba(255,255,255,0.15)';
        ctx.font = '14px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('地図画像をアップロードしてください', w / 2, h / 2);
        return;
    }

    const spots = draftMap?.config?.spots || [];
    for (const spot of spots) {
        const px = spot.u * w;
        const py = spot.v * h;
        const isSel = spot.id === selectedSpotId;
        ctx.beginPath();
        ctx.arc(px, py, isSel ? 10 : 7, 0, Math.PI * 2);
        ctx.fillStyle = isSel ? '#ff9800' : '#f57c00';
        ctx.fill();
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.fillStyle = '#fff';
        ctx.font = 'bold 12px sans-serif';
        ctx.textAlign = 'left';
        ctx.fillText(spot.name, px + 12, py + 4);
    }
}

/**
 * クリック位置から正規化 UV を求める
 * @param {MouseEvent} e
 * @returns {{ u: number, v: number }|null}
 */
function clickToUv(e) {
    const canvas = /** @type {HTMLCanvasElement|null} */ (document.getElementById('ac-map-preview-canvas'));
    if (!canvas || !mapPreviewImage) return null;
    const rect = canvas.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * canvas.width;
    const y = ((e.clientY - rect.top) / rect.height) * canvas.height;
    const u = Math.max(0, Math.min(1, x / canvas.width));
    const v = Math.max(0, Math.min(1, y / canvas.height));
    return { u, v };
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
    const sel = /** @type {HTMLSelectElement|null} */ (document.getElementById('ac-map-world-select'));
    if (sel) sel.value = worldId;
    try {
        const j = await fetchJson(`/admin/addons/aircraft/flight-maps/${encodeURIComponent(worldId)}`);
        draftMap = j.map || {
            worldId,
            imagePath: '',
            imageUrl: '',
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
    /** @type {Record<string, { name?: string }>} */
    let worlds = {};
    try {
        worlds = await fetchJson('/admin/worlds');
    } catch {
        worlds = {};
    }
    sel.innerHTML = '';
    const ids = Object.keys(worlds).sort();
    for (const id of ids) {
        const opt = document.createElement('option');
        opt.value = id;
        opt.textContent = worlds[id]?.name ? `${worlds[id].name} (${id})` : id;
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
                body: JSON.stringify({
                    imagePath: draftMap.imagePath || '',
                    config,
                }),
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
                <p class="hint">ワールドごとに飛行ミニマップ用地図を登録します。<strong>画像の上方向が北</strong>です。地図上をクリックしてスポット（松山空港・松山城など）を配置できます。</p>
                <div class="field-row">
                    <label class="prop-label" for="ac-map-world-select">対象ワールド</label>
                    <select id="ac-map-world-select" class="prop-input full"></select>
                </div>
                <div class="field-row">
                    <button type="button" class="btn btn-secondary" id="ac-map-btn-upload">地図画像をアップロード</button>
                    <input type="file" id="ac-map-image-input" accept=".png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp" hidden />
                </div>
                <div class="prop-group-label">ワールド座標 ↔ 地図（北=画像上端）</div>
                <div class="field-row"><label class="prop-label" for="ac-map-west">西端 X</label>
                    <input type="number" id="ac-map-west" class="prop-input num" step="any" /></div>
                <div class="field-row"><label class="prop-label" for="ac-map-east">東端 X</label>
                    <input type="number" id="ac-map-east" class="prop-input num" step="any" /></div>
                <div class="field-row"><label class="prop-label" for="ac-map-north">北端 Z</label>
                    <input type="number" id="ac-map-north" class="prop-input num" step="any" /></div>
                <div class="field-row"><label class="prop-label" for="ac-map-south">南端 Z</label>
                    <input type="number" id="ac-map-south" class="prop-input num" step="any" /></div>
                <div class="field-row"><label class="prop-label" for="ac-map-radius">ミニマップ半径 (m)</label>
                    <input type="number" id="ac-map-radius" class="prop-input num" step="50" min="50" /></div>
                <div class="field-row"><label class="prop-label" for="ac-map-icon-offset">機体アイコン向き補正 (°)</label>
                    <input type="number" id="ac-map-icon-offset" class="prop-input num" step="1" /></div>
                <div class="ac-admin-actions">
                    <button type="button" class="btn btn-primary" id="ac-map-btn-save">保存</button>
                </div>
                <p id="ac-map-status" class="status-text" role="status"></p>
            </aside>
            <div class="ac-map-admin-center">
                <div class="ac-map-preview-wrap">
                    <canvas id="ac-map-preview-canvas" class="ac-map-preview-canvas" width="960" height="640"></canvas>
                    <img id="ac-map-preview-img" alt="" hidden />
                </div>
                <p class="hint">地図をクリック → スポット名を入力。選択中スポットは削除できます。</p>
            </div>
            <aside class="ac-map-admin-right">
                <h3 class="section-subtitle">スポット一覧</h3>
                <div class="ac-admin-actions">
                    <button type="button" class="btn btn-sm btn-outline-secondary" id="ac-map-spot-rename">名前変更</button>
                    <button type="button" class="btn btn-sm btn-outline-secondary" id="ac-map-spot-delete">削除</button>
                </div>
                <div id="ac-map-spot-list" class="ac-map-spot-list"></div>
            </aside>
        </div>
    `;

    document.getElementById('ac-map-world-select')?.addEventListener('change', (e) => {
        const id = /** @type {HTMLSelectElement} */ (e.target).value;
        if (id) void selectWorld(id);
    });

    document.getElementById('ac-map-btn-upload')?.addEventListener('click', () => {
        document.getElementById('ac-map-image-input')?.click();
    });

    document.getElementById('ac-map-image-input')?.addEventListener('change', async (ev) => {
        const input = /** @type {HTMLInputElement} */ (ev.target);
        const file = input.files && input.files[0];
        input.value = '';
        if (!file || !selectedWorldId) return;
        try {
            setMapStatus('画像をアップロード中…');
            const form = new FormData();
            form.append('image', file, file.name);
            const res = await fetch(
                `/admin/addons/aircraft/flight-maps/${encodeURIComponent(selectedWorldId)}/upload-image`,
                { method: 'POST', credentials: 'include', body: form }
            );
            const j = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
            if (!draftMap) draftMap = { worldId: selectedWorldId, config: defaultMapConfig() };
            draftMap.imagePath = j.imagePath;
            draftMap.imageUrl = j.imageUrl;
            syncMapFormFromDraft(draftMap);
            setMapStatus('画像をアップロードしました（保存ボタンで確定）');
        } catch (e) {
            setMapStatus(e instanceof Error ? e.message : String(e), true);
        }
    });

    document.getElementById('ac-map-btn-save')?.addEventListener('click', () => {
        void saveMapDraft();
    });

    document.getElementById('ac-map-preview-canvas')?.addEventListener('click', (e) => {
        if (!draftMap?.imageUrl) return;
        const uv = clickToUv(/** @type {MouseEvent} */ (e));
        if (!uv) return;
        const name = window.prompt('スポット名', 'スポット');
        if (name == null || !name.trim()) return;
        const cfg = readConfigFromForm();
        const id = nextSpotId();
        cfg.spots.push({ id, name: name.trim(), u: uv.u, v: uv.v });
        draftMap.config = cfg;
        selectedSpotId = id;
        syncMapFormFromDraft(draftMap);
        setMapStatus(`スポット追加: ${name.trim()}`);
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
