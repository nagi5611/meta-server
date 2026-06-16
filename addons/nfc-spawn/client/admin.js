// addons/nfc-spawn/client/admin.js — 管理画面に NFCタグパネル（3Dワールド配置付き）
const PANEL_ID = 'panel-addon-nfc-spawn';
const NAV_DATA_PANEL = 'panel-addon-nfc-spawn';
const API_BASE = '/admin/addons/nfc-spawn/spawns';

/** NFC アイコン（Bootstrap Icons に bi-nfc が無いためインライン SVG） */
const NFC_NAV_ICON_SVG = `<svg class="nfc-admin-nav-svg" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="1.1em" height="1.1em" fill="currentColor" aria-hidden="true"><path d="M4.5 2A2.5 2.5 0 0 0 2 4.5v7A2.5 2.5 0 0 0 4.5 14h7a2.5 2.5 0 0 0 2.5-2.5v-7A2.5 2.5 0 0 0 11.5 2h-7zm0 1h7A1.5 1.5 0 0 1 13 4.5v7a1.5 1.5 0 0 1-1.5 1.5h-7A1.5 1.5 0 0 1 3 11.5v-7A1.5 1.5 0 0 1 4.5 3z"/><path d="M5.1 5.05a.5.5 0 0 0-.7.7 2.9 2.9 0 0 1 0 4.1.5.5 0 1 0 .7.7 3.9 3.9 0 0 0 0-5.5.5.5 0 0 0-.7 0zm5.6 0a.5.5 0 0 1 .7.7 3.9 3.9 0 0 1 0 5.5.5.5 0 1 1-.7-.7 2.9 2.9 0 0 0 0-4.1.5.5 0 0 1 .7-.7z"/><path d="M6.45 6.4a.5.5 0 0 0-.63.77 1.2 1.2 0 0 1 0 1.46.5.5 0 1 0 .78.64 2.2 2.2 0 0 0 0-2.74.5.5 0 0 0-.15-.13zm3.34 0a.5.5 0 0 1 .78-.64 2.2 2.2 0 0 1 0 2.74.5.5 0 0 1-.78-.64 1.2 1.2 0 0 0 0-1.46.5.5 0 0 1 .15-.13z"/><circle cx="8" cy="8" r=".85"/></svg>`;

/** @type {string[]} */
let worldIds = [];

/** @type {Record<string, object>} */
let worldsData = {};

/** @type {object[]} */
let spawns = [];

/** @type {number|null} */
let editingId = null;

/** @type {Set<number>} */
let excludedPreviewIndices = new Set();

/** @type {Set<string>} worldModelIndex:partIndex */
let excludedPreviewParts = new Set();

/** @type {ReturnType<typeof setTimeout>|null} */
let previewDebounceTimer = null;

/** @type {import('./world-placer-viewer.js').NfcSpawnWorldPlacer|null} */
let worldPlacer = null;

/** @type {Promise<void>|null} */
let viewerInitPromise = null;

/**
 * @param {string} path
 * @param {RequestInit} [init]
 */
async function apiFetch(path, init) {
    const r = await fetch(path, { credentials: 'include', ...init });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
        const err = new Error(j.error || `HTTP ${r.status}`);
        throw err;
    }
    return j;
}

/**
 * クライアント側でインスタンス URL を組み立てる（API 未返却時のフォールバック）
 * @param {string} token
 */
function buildClientInstanceUrl(token) {
    const t = String(token || '').trim();
    if (!t) return '';
    return `${window.location.origin}/instance/?token=${encodeURIComponent(t)}`;
}

/**
 * クライアント側でテレポート URL を組み立てる
 * @param {string} token
 */
function buildClientSpawnUrl(token) {
    const t = String(token || '').trim();
    if (!t) return '';
    return `${window.location.origin}/?spawn=${encodeURIComponent(t)}`;
}

/**
 * 編集中スポーンのトークン（メタ表示から）
 */
function getMetaSpawnToken() {
    const el = document.getElementById('nfc-spawn-meta-token');
    const t = el?.textContent?.trim();
    if (!t || t === '-') return '';
    return t;
}

/**
 * コピー用 URL を解決（API 値 → トークンから組み立て）
 * @param {'spawn'|'instance'} kind
 * @param {object} [row]
 */
function resolveCopyUrl(kind, row = null) {
    const token = row?.spawn_token || getMetaSpawnToken();
    if (kind === 'instance') {
        return row?.instanceUrl || buildClientInstanceUrl(token);
    }
    return row?.spawnUrl || buildClientSpawnUrl(token);
}

/**
 * URL コピーボタンと表示欄を同期
 * @param {object} [row]
 */
function syncCopyUrlButtons(row = null) {
    const type = row?.type === 'instance' || row?.type === 'teleport' ? row.type : getSelectedType();
    const copyUrlBtn = document.getElementById('nfc-spawn-copy-url');
    const copyInstBtn = document.getElementById('nfc-spawn-copy-instance-url');
    const urlDisplay = /** @type {HTMLInputElement|null} */ (
        document.getElementById('nfc-spawn-instance-url-display')
    );
    const urlWrap = document.getElementById('nfc-spawn-instance-url-wrap');
    const spawnUrl = resolveCopyUrl('spawn', row);
    const instanceUrl = resolveCopyUrl('instance', row);

    if (copyUrlBtn) {
        copyUrlBtn.dataset.url = spawnUrl;
        copyUrlBtn.hidden = type === 'instance';
    }
    if (copyInstBtn) {
        copyInstBtn.dataset.url = instanceUrl;
        copyInstBtn.hidden = type !== 'instance';
        copyInstBtn.disabled = !instanceUrl;
    }
    if (urlWrap) urlWrap.hidden = type !== 'instance';
    if (urlDisplay) {
        urlDisplay.value = instanceUrl;
        urlDisplay.placeholder = instanceUrl ? '' : '保存後に URL が表示されます';
    }
}

/**
 * @param {string} text
 */
async function copyText(text) {
    const value = String(text || '').trim();
    if (!value) return false;
    try {
        if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(value);
            return true;
        }
    } catch {
        /* fallback below */
    }
    try {
        const ta = document.createElement('textarea');
        ta.value = value;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.top = '0';
        ta.style.left = '0';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        ta.setSelectionRange(0, value.length);
        const ok = document.execCommand('copy');
        document.body.removeChild(ta);
        return ok;
    } catch {
        return false;
    }
}

/**
 * @param {string} s
 */
function escapeHtml(s) {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/**
 * サイドバー・パネル DOM を挿入
 */
function ensurePanelDom() {
    if (document.getElementById(PANEL_ID)) return;

    const nav = document.querySelector('.admin-nav');
    const panels = document.querySelector('.admin-panels');
    if (!nav || !panels) return;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'admin-nav-item';
    btn.dataset.panel = NAV_DATA_PANEL;
    btn.innerHTML = `${NFC_NAV_ICON_SVG}<span>NFCタグ</span>`;
    const addonsBtn = nav.querySelector('[data-panel="panel-addons"]');
    if (addonsBtn) nav.insertBefore(btn, addonsBtn);
    else nav.appendChild(btn);

    const panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.className = 'admin-panel';
    panel.innerHTML = `
        <section class="nfc-spawn-section">
            <h2>NFCタグ・スポーン地点</h2>
            <p class="hint">3D プレビュー上の<strong>緑のマーカー</strong>をドラッグして位置を決めます。<strong>テレポート</strong>型は <code>/?spawn=TOKEN</code>、<strong>インスタンス</strong>型は <code>/instance/?token=TOKEN</code>（A-Frame 閲覧専用）です。</p>
            <p id="nfc-spawn-status" class="status-text" role="status"></p>

            <div class="nfc-spawn-toolbar">
                <label class="nfc-spawn-label nfc-spawn-toolbar-world">ワールド
                    <select id="nfc-spawn-world"></select>
                </label>
                <button type="button" class="btn btn-secondary" id="nfc-spawn-reload-world">ワールド再読込</button>
                <button type="button" class="btn btn-primary" id="nfc-spawn-new-btn">新規配置</button>
            </div>

            <div class="nfc-spawn-main-layout">
                <div class="nfc-spawn-viewer-wrap">
                    <div id="nfc-spawn-viewer-mount" class="nfc-spawn-viewer-mount" aria-label="ワールド3Dプレビュー"></div>
                    <p class="hint nfc-spawn-viewer-hint">マーカーをドラッグして移動・向きは Yaw で調整</p>
                </div>

                <div class="nfc-spawn-side">
                    <div class="nfc-spawn-form-card">
                        <h3 id="nfc-spawn-form-title">新規 NFC タグ</h3>
                        <form id="nfc-spawn-form" class="nfc-spawn-form">
                            <input type="hidden" id="nfc-spawn-edit-id" value="">
                            <label class="nfc-spawn-label">タイプ
                                <select id="nfc-spawn-type">
                                    <option value="teleport">テレポート（フルメタバース）</option>
                                    <option value="instance">インスタンス（スマホ閲覧専用）</option>
                                </select>
                            </label>
                            <div id="nfc-spawn-instance-fields" class="nfc-spawn-instance-fields" hidden>
                                <label class="nfc-spawn-label">ロード半径 (m)
                                    <input type="range" id="nfc-spawn-load-radius" min="1" max="100" step="1" value="15">
                                    <span id="nfc-spawn-load-radius-val">15 m</span>
                                </label>
                                <div class="nfc-spawn-bake-preview-wrap">
                                    <h4>球内モデル（パーツ単位プレビュー）</h4>
                                    <ul id="nfc-spawn-bake-preview" class="nfc-spawn-bake-preview"></ul>
                                </div>
                                <p id="nfc-spawn-bake-status" class="nfc-spawn-bake-status"></p>
                                <button type="button" class="btn btn-secondary" id="nfc-spawn-bake-btn">インスタンスを生成 / 再ベイク</button>
                            </div>
                            <label class="nfc-spawn-label">ラベル
                                <input type="text" id="nfc-spawn-label" required maxlength="128" placeholder="図書館模型">
                            </label>
                            <div class="nfc-spawn-coords">
                                <label>X <input type="number" id="nfc-spawn-x" step="any" value="0" readonly></label>
                                <label>Y <input type="number" id="nfc-spawn-y" step="any" value="10" readonly></label>
                                <label>Z <input type="number" id="nfc-spawn-z" step="any" value="0" readonly></label>
                                <label>Yaw° <input type="number" id="nfc-spawn-yaw" step="any" value="0"></label>
                            </div>
                            <label class="nfc-spawn-label">NFC UID（任意・メモ）
                                <input type="text" id="nfc-spawn-uid" maxlength="64" placeholder="04:AB:...">
                            </label>
                            <label class="nfc-spawn-check">
                                <input type="checkbox" id="nfc-spawn-enabled" checked> 有効
                            </label>
                            <div class="nfc-spawn-form-actions">
                                <button type="submit" class="btn btn-primary" id="nfc-spawn-save-btn">NFCタグを追加</button>
                                <button type="button" class="btn btn-secondary" id="nfc-spawn-cancel-btn" hidden>キャンセル</button>
                            </div>
                        </form>
                        <div id="nfc-spawn-edit-meta" class="nfc-spawn-edit-meta" hidden>
                            <p><strong>ID:</strong> <span id="nfc-spawn-meta-id">-</span></p>
                            <p><strong>トークン:</strong> <code id="nfc-spawn-meta-token" class="nfc-spawn-token-code">-</code></p>
                            <p id="nfc-spawn-instance-url-wrap" class="nfc-spawn-instance-url-wrap" hidden>
                                <strong>インスタンス URL</strong>
                                <span class="nfc-spawn-url-row">
                                    <input type="text" id="nfc-spawn-instance-url-display" class="prop-input nfc-spawn-url-input" readonly placeholder="保存後に URL が表示されます">
                                    <button type="button" class="btn btn-secondary btn-sm" id="nfc-spawn-copy-instance-url">コピー</button>
                                </span>
                            </p>
                            <div class="nfc-spawn-meta-actions">
                                <button type="button" class="btn btn-secondary btn-sm" id="nfc-spawn-copy-url">テレポートURL</button>
                                <button type="button" class="btn btn-secondary btn-sm" id="nfc-spawn-regen-btn">トークン再発行</button>
                            </div>
                        </div>
                    </div>

                    <div class="nfc-spawn-table-wrap">
                        <h3>登録一覧 <span id="nfc-spawn-list-count" class="nfc-spawn-list-count"></span></h3>
                        <div class="table-responsive nfc-spawn-table-scroll">
                            <table class="nfc-spawn-table">
                                <thead>
                                    <tr>
                                        <th>タイプ</th>
                                        <th>ID</th>
                                        <th>ラベル</th>
                                        <th>座標</th>
                                        <th>有効</th>
                                        <th>操作</th>
                                    </tr>
                                </thead>
                                <tbody id="nfc-spawn-tbody"></tbody>
                            </table>
                        </div>
                    </div>
                </div>
            </div>
        </section>
    `;
    panels.appendChild(panel);
    btn.addEventListener('click', () => {
        document.dispatchEvent(new CustomEvent('admin-panel-request', { detail: { panelId: NAV_DATA_PANEL } }));
    });
}

/**
 * 3D ビューア初期化
 */
async function ensureWorldPlacer() {
    if (worldPlacer) return worldPlacer;
    if (viewerInitPromise) {
        await viewerInitPromise;
        return worldPlacer;
    }
    viewerInitPromise = (async () => {
        const mount = document.getElementById('nfc-spawn-viewer-mount');
        if (!mount) return;
        const mod = await import('./world-placer-viewer.js');
        worldPlacer = new mod.NfcSpawnWorldPlacer(mount);
        worldPlacer.onPlacementChange = (pos) => {
            const set = (id, val) => {
                const el = document.getElementById(id);
                if (el) el.value = String(val);
            };
            set('nfc-spawn-x', pos.x);
            set('nfc-spawn-y', pos.y);
            set('nfc-spawn-z', pos.z);
            set('nfc-spawn-yaw', pos.yaw);
            if (getSelectedType() === 'instance' && worldPlacer) {
                worldPlacer.updateLoadSphereAt({ x: pos.x, y: pos.y, z: pos.z });
            }
            scheduleBakePreviewRefresh();
        };
        worldPlacer.onTagMarkerPick = (id) => {
            const row = spawns.find((s) => s.id === id);
            if (row) selectSpawnRow(row);
        };
    })();
    await viewerInitPromise;
    return worldPlacer;
}

/**
 * @returns {string}
 */
function getSelectedWorldId() {
    return /** @type {HTMLSelectElement} */ (document.getElementById('nfc-spawn-world'))?.value || worldIds[0] || '';
}

/**
 * @returns {'teleport'|'instance'}
 */
function getSelectedType() {
    const v = /** @type {HTMLSelectElement} */ (document.getElementById('nfc-spawn-type'))?.value;
    return v === 'instance' ? 'instance' : 'teleport';
}

/**
 * @returns {number}
 */
function getLoadRadius() {
    return parseFloat(/** @type {HTMLInputElement} */ (document.getElementById('nfc-spawn-load-radius'))?.value) || 15;
}

function syncTypeUi() {
    const type = getSelectedType();
    const instanceFields = document.getElementById('nfc-spawn-instance-fields');
    if (instanceFields) instanceFields.hidden = type !== 'instance';
    syncCopyUrlButtons();
    const radiusVal = document.getElementById('nfc-spawn-load-radius-val');
    if (radiusVal) radiusVal.textContent = `${getLoadRadius()} m`;
    void ensureWorldPlacer().then((p) => {
        if (!p) return;
        if (type === 'instance') {
            p.setLoadSphereVisible(true);
            p.setLoadRadius(getLoadRadius());
            const x = parseFloat(/** @type {HTMLInputElement} */ (document.getElementById('nfc-spawn-x'))?.value);
            const y = parseFloat(/** @type {HTMLInputElement} */ (document.getElementById('nfc-spawn-y'))?.value);
            const z = parseFloat(/** @type {HTMLInputElement} */ (document.getElementById('nfc-spawn-z'))?.value);
            if ([x, y, z].every(Number.isFinite)) p.updateLoadSphereAt({ x, y, z });
        } else {
            p.setLoadSphereVisible(false);
        }
    });
    void refreshBakePreview();
}

function scheduleBakePreviewRefresh() {
    if (previewDebounceTimer) clearTimeout(previewDebounceTimer);
    previewDebounceTimer = setTimeout(() => void refreshBakePreview(), 350);
}

/**
 * インスタンス型のプレビュー・ベイクに必要な入力が揃っているか
 */
function canUseInstanceBakeDraft() {
    if (getSelectedType() !== 'instance') return false;
    const body = readFormBody();
    if (!body.world_id) return false;
    if (![body.x, body.y, body.z].every((n) => Number.isFinite(n))) return false;
    if (!Number.isFinite(body.load_radius)) return false;
    return true;
}

/**
 * ベイク API 用ボディ（ラベル未入力時は自動生成）
 */
function readBakeRequestBody() {
    const body = readFormBody();
    if (!body.label?.trim()) {
        body.label = `インスタンス ${body.world_id || getSelectedWorldId()}`;
    }
    body.excludeModelIndices = [...excludedPreviewIndices];
    body.excludeParts = [...excludedPreviewParts];
    if (editingId != null) body.id = editingId;
    return body;
}

/**
 * @param {object|null} [row]
 */
function updateBakeStatus(row = null) {
    const el = document.getElementById('nfc-spawn-bake-status');
    if (!el) return;
    const r =
        row ||
        (editingId != null ? spawns.find((s) => s.id === editingId) : null);
    if (!r || r.type !== 'instance') {
        el.textContent = '';
        return;
    }
    if (r.hasBake) {
        el.textContent = `ベイク済み: rev ${r.bake_revision} / ${r.baked_at || ''}`;
    } else {
        el.textContent = '未ベイク（インスタンス URL はベイク後に有効）';
    }
}

async function refreshBakePreview() {
    const list = document.getElementById('nfc-spawn-bake-preview');
    const bakeBtn = document.getElementById('nfc-spawn-bake-btn');
    if (!list) return;
    if (getSelectedType() !== 'instance') {
        list.innerHTML = '';
        if (bakeBtn) bakeBtn.disabled = true;
        return;
    }
    if (!canUseInstanceBakeDraft()) {
        list.innerHTML =
            '<li class="nfc-spawn-preview-hint">3D で位置を決め、半径を設定してください</li>';
        if (bakeBtn) bakeBtn.disabled = true;
        return;
    }
    try {
        const j = await apiFetch(`${API_BASE}/bake-preview`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(readBakeRequestBody()),
        });
        const entries = j.preview?.entries || [];
        if (!entries.length) {
            list.innerHTML = '<li class="nfc-spawn-preview-hint">半径内にモデルなし</li>';
        } else {
            list.innerHTML = entries
                .map((e) => {
                    if (e.entryKind === 'prefab_part') {
                        const partKey = `${e.worldModelIndex}:${e.partIndex}`;
                        const included = !excludedPreviewParts.has(partKey);
                        const checked = included ? ' checked' : '';
                        return `<li class="nfc-spawn-preview-part"><label><input type="checkbox" class="nfc-preview-include-part" data-part-key="${escapeHtml(partKey)}"${checked}> <code>prefab</code> ${escapeHtml(e.label)} <span class="nfc-spawn-part-idx">#${e.partIndex}</span></label></li>`;
                    }
                    const included = !excludedPreviewIndices.has(e.worldModelIndex);
                    const checked = included ? ' checked' : '';
                    const parts = e.partIndices?.length ? ` parts:${e.partIndices.join(',')}` : '';
                    return `<li><label><input type="checkbox" class="nfc-preview-include" data-idx="${e.worldModelIndex}"${checked}> ${escapeHtml(e.label)} <code>${escapeHtml(e.entryKind)}</code>${escapeHtml(parts)}</label></li>`;
                })
                .join('');
            list.querySelectorAll('.nfc-preview-include').forEach((cb) => {
                cb.addEventListener('change', () => {
                    const idx = Number(cb.getAttribute('data-idx'));
                    if (/** @type {HTMLInputElement} */ (cb).checked) excludedPreviewIndices.delete(idx);
                    else excludedPreviewIndices.add(idx);
                    scheduleBakePreviewRefresh();
                });
            });
            list.querySelectorAll('.nfc-preview-include-part').forEach((cb) => {
                cb.addEventListener('change', () => {
                    const key = cb.getAttribute('data-part-key') || '';
                    if (/** @type {HTMLInputElement} */ (cb).checked) excludedPreviewParts.delete(key);
                    else excludedPreviewParts.add(key);
                    scheduleBakePreviewRefresh();
                });
            });
        }
        if (bakeBtn) bakeBtn.disabled = false;
    } catch (e) {
        const msg = e instanceof Error ? e.message : 'プレビュー取得失敗';
        list.innerHTML = `<li class="nfc-spawn-preview-hint">${escapeHtml(msg)}</li>`;
        if (bakeBtn) bakeBtn.disabled = true;
    }
}

/**
 * 選択ワールドの 3D とマーカーを更新
 */
async function reloadWorldViewer() {
    const worldId = getSelectedWorldId();
    const placer = await ensureWorldPlacer();
    if (!placer || !worldId) return;
    setStatus('ワールドを読み込み中…');
    try {
        const world = worldsData[worldId];
        if (world) await placer.loadWorld(world);
        refreshWorldMarkers();
        syncTypeUi();
        if (!editingId && world) {
            const placer = worldPlacer;
            if (placer) placer.focusDefaultSpawn(world);
        }
        setStatus('');
    } catch (e) {
        setStatus(e instanceof Error ? e.message : 'ワールド読込失敗', true);
    }
}

/**
 * 現在ワールドのタグマーカーを 3D に反映
 */
function refreshWorldMarkers() {
    if (!worldPlacer) return;
    const worldId = getSelectedWorldId();
    const filtered = spawns.filter((s) => s.world_id === worldId);
    worldPlacer.setTagMarkers(filtered, editingId);
}

/**
 * NFC パネルを表示
 */
function showNfcSpawnPanel() {
    document.querySelectorAll('.admin-panel').forEach((el) => el.classList.remove('active'));
    document.querySelectorAll('.admin-nav-item').forEach((el) => el.classList.remove('active'));
    const panel = document.getElementById(PANEL_ID);
    const nav = document.querySelector(`.admin-nav-item[data-panel="${NAV_DATA_PANEL}"]`);
    if (panel) panel.classList.add('active');
    if (nav) nav.classList.add('active');
    void refreshNfcSpawnPanel();
}

/**
 * @param {string} msg
 * @param {boolean} [isError]
 */
function setStatus(msg, isError = false) {
    const el = document.getElementById('nfc-spawn-status');
    if (!el) return;
    el.textContent = msg;
    el.classList.toggle('error', isError);
}

function populateWorldSelect() {
    const sel = document.getElementById('nfc-spawn-world');
    if (!sel) return;
    const prev = sel.value;
    sel.innerHTML = worldIds
        .map((id) => `<option value="${escapeHtml(id)}">${escapeHtml(id)}</option>`)
        .join('');
    if (prev && worldIds.includes(prev)) sel.value = prev;
}

function resetForm() {
    editingId = null;
    excludedPreviewIndices = new Set();
    excludedPreviewParts = new Set();
    const title = document.getElementById('nfc-spawn-form-title');
    const cancel = document.getElementById('nfc-spawn-cancel-btn');
    const saveBtn = document.getElementById('nfc-spawn-save-btn');
    const editId = document.getElementById('nfc-spawn-edit-id');
    const meta = document.getElementById('nfc-spawn-edit-meta');
    if (title) title.textContent = '新規 NFC タグ';
    if (cancel) cancel.hidden = true;
    if (saveBtn) saveBtn.textContent = 'NFCタグを追加';
    if (editId) editId.value = '';
    if (meta) meta.hidden = true;
    const form = document.getElementById('nfc-spawn-form');
    if (form) form.reset();
    const enabled = document.getElementById('nfc-spawn-enabled');
    if (enabled) enabled.checked = true;
    const worldSel = document.getElementById('nfc-spawn-world');
    if (worldSel && worldSel.value) {
        /* keep world */
    }
    refreshWorldMarkers();
    void ensureWorldPlacer().then((p) => {
        if (!p) return;
        const world = worldsData[getSelectedWorldId()];
        if (world) p.focusDefaultSpawn(world);
    });
    syncTypeUi();
    scheduleBakePreviewRefresh();
}

/**
 * @param {object} row
 */
function selectSpawnRow(row) {
    if (row.world_id && row.world_id !== getSelectedWorldId()) {
        const sel = document.getElementById('nfc-spawn-world');
        if (sel) sel.value = row.world_id;
        void reloadWorldViewer().then(() => fillForm(row));
        return;
    }
    fillForm(row);
}

/**
 * @param {object} row
 */
function fillForm(row) {
    editingId = row.id;
    const title = document.getElementById('nfc-spawn-form-title');
    const cancel = document.getElementById('nfc-spawn-cancel-btn');
    const saveBtn = document.getElementById('nfc-spawn-save-btn');
    const editId = document.getElementById('nfc-spawn-edit-id');
    const meta = document.getElementById('nfc-spawn-edit-meta');
    if (title) title.textContent = `編集: ${row.label}`;
    if (cancel) cancel.hidden = false;
    if (saveBtn) saveBtn.textContent = '変更を保存';
    if (editId) editId.value = String(row.id);
    if (meta) meta.hidden = false;
    const set = (id, val) => {
        const el = document.getElementById(id);
        if (el) el.value = val;
    };
    set('nfc-spawn-label', row.label);
    set('nfc-spawn-x', row.x);
    set('nfc-spawn-y', row.y);
    set('nfc-spawn-z', row.z);
    set('nfc-spawn-yaw', row.yaw ?? 0);
    set('nfc-spawn-uid', row.nfc_tag_uid || '');
    const typeSel = document.getElementById('nfc-spawn-type');
    if (typeSel) typeSel.value = row.type === 'instance' ? 'instance' : 'teleport';
    const radiusInput = document.getElementById('nfc-spawn-load-radius');
    if (radiusInput && row.load_radius != null) {
        radiusInput.value = String(row.load_radius);
    }
    const enabled = document.getElementById('nfc-spawn-enabled');
    if (enabled) enabled.checked = row.enabled !== false;
    const metaId = document.getElementById('nfc-spawn-meta-id');
    const metaToken = document.getElementById('nfc-spawn-meta-token');
    if (metaId) metaId.textContent = String(row.id);
    if (metaToken) metaToken.textContent = row.spawn_token || '-';
    syncCopyUrlButtons(row);
    updateBakeStatus(row);
    syncTypeUi();
    refreshWorldMarkers();
    void ensureWorldPlacer().then((p) => {
        if (!p) return;
        p.showPlacementMarker({ x: row.x, y: row.y, z: row.z, yaw: row.yaw ?? 0 });
    });
}

function readFormBody() {
    const label = /** @type {HTMLInputElement} */ (document.getElementById('nfc-spawn-label'))?.value?.trim();
    const world_id = getSelectedWorldId();
    const x = parseFloat(/** @type {HTMLInputElement} */ (document.getElementById('nfc-spawn-x'))?.value);
    const y = parseFloat(/** @type {HTMLInputElement} */ (document.getElementById('nfc-spawn-y'))?.value);
    const z = parseFloat(/** @type {HTMLInputElement} */ (document.getElementById('nfc-spawn-z'))?.value);
    const yaw = parseFloat(/** @type {HTMLInputElement} */ (document.getElementById('nfc-spawn-yaw'))?.value);
    const uidRaw = /** @type {HTMLInputElement} */ (document.getElementById('nfc-spawn-uid'))?.value?.trim();
    const enabled = /** @type {HTMLInputElement} */ (document.getElementById('nfc-spawn-enabled'))?.checked;
    const type = getSelectedType();
    const body = {
        label,
        world_id,
        x,
        y,
        z,
        yaw: Number.isFinite(yaw) ? yaw : 0,
        nfc_tag_uid: uidRaw || null,
        enabled: enabled !== false,
        type,
    };
    if (type === 'instance') {
        body.load_radius = getLoadRadius();
    }
    return body;
}

function renderTable() {
    const tbody = document.getElementById('nfc-spawn-tbody');
    const countEl = document.getElementById('nfc-spawn-list-count');
    const worldId = getSelectedWorldId();
    const filtered = spawns.filter((s) => s.world_id === worldId);
    if (countEl) countEl.textContent = filtered.length ? `(${filtered.length})` : '';
    if (!tbody) return;
    if (!filtered.length) {
        tbody.innerHTML = '<tr><td colspan="6" class="nfc-spawn-empty">このワールドに登録なし</td></tr>';
        return;
    }
    tbody.innerHTML = filtered
        .map((row) => {
            const coord = `${row.x}, ${row.y}, ${row.z}`;
            const enabledMark = row.enabled ? '有効' : '無効';
            const typeLabel = row.type === 'instance' ? 'インスタンス' : 'テレポート';
            const sel = row.id === editingId ? ' class="nfc-spawn-row-selected"' : '';
            return `<tr data-id="${row.id}"${sel}>
                <td>${typeLabel}</td>
                <td><code>${row.id}</code></td>
                <td>${escapeHtml(row.label)}</td>
                <td><code>${escapeHtml(coord)}</code></td>
                <td>${enabledMark}</td>
                <td class="nfc-spawn-actions">
                    <button type="button" class="btn btn-secondary btn-sm nfc-locate">表示</button>
                    <button type="button" class="btn btn-secondary btn-sm nfc-delete">削除</button>
                </td>
            </tr>`;
        })
        .join('');

    tbody.querySelectorAll('.nfc-locate').forEach((btn) => {
        btn.addEventListener('click', () => {
            const tr = btn.closest('tr');
            const id = Number(tr?.getAttribute('data-id'));
            const row = spawns.find((s) => s.id === id);
            if (row) selectSpawnRow(row);
        });
    });
    tbody.querySelectorAll('.nfc-delete').forEach((btn) => {
        btn.addEventListener('click', async () => {
            const tr = btn.closest('tr');
            const id = Number(tr?.getAttribute('data-id'));
            if (!id || !window.confirm('このタグを削除しますか？')) return;
            try {
                await apiFetch(`${API_BASE}/${id}`, { method: 'DELETE' });
                setStatus('削除しました');
                if (editingId === id) resetForm();
                await refreshNfcSpawnPanel();
            } catch (e) {
                setStatus(e instanceof Error ? e.message : '削除に失敗', true);
            }
        });
    });
}

async function refreshNfcSpawnPanel() {
    try {
        const worldsRes = await apiFetch('/admin/worlds');
        worldsData = worldsRes && typeof worldsRes === 'object' ? worldsRes : {};
        worldIds = Object.keys(worldsData).sort();
        populateWorldSelect();
        const j = await apiFetch(API_BASE);
        spawns = j.spawns || [];
        renderTable();
        if (editingId != null) {
            const row = spawns.find((s) => s.id === editingId);
            if (row) syncCopyUrlButtons(row);
        }
        refreshWorldMarkers();
        await reloadWorldViewer();
    } catch (e) {
        setStatus(e instanceof Error ? e.message : '読み込みに失敗', true);
    }
}

function bindForm() {
    const form = document.getElementById('nfc-spawn-form');
    const cancel = document.getElementById('nfc-spawn-cancel-btn');
    const worldSel = document.getElementById('nfc-spawn-world');
    const reloadBtn = document.getElementById('nfc-spawn-reload-world');
    const newBtn = document.getElementById('nfc-spawn-new-btn');
    const yawInput = document.getElementById('nfc-spawn-yaw');
    const copyUrlBtn = document.getElementById('nfc-spawn-copy-url');
    const copyInstBtn = document.getElementById('nfc-spawn-copy-instance-url');
    const regenBtn = document.getElementById('nfc-spawn-regen-btn');
    const typeSel = document.getElementById('nfc-spawn-type');
    const radiusInput = document.getElementById('nfc-spawn-load-radius');
    const bakeBtn = document.getElementById('nfc-spawn-bake-btn');

    if (!form) return;

    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const body = readFormBody();
        if (!body.label) {
            setStatus('ラベルを入力してください', true);
            return;
        }
        if (![body.x, body.y, body.z].every((n) => Number.isFinite(n))) {
            setStatus('3D ビューアで位置を決めてください', true);
            return;
        }
        try {
            if (editingId != null) {
                const j = await apiFetch(`${API_BASE}/${editingId}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body),
                });
                setStatus('更新しました');
                if (j.spawn) fillForm(j.spawn);
            } else {
                const j = await apiFetch(API_BASE, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body),
                });
                setStatus('NFCタグを追加しました');
                if (j.spawn) fillForm(j.spawn);
            }
            await refreshNfcSpawnPanel();
        } catch (err) {
            setStatus(err instanceof Error ? err.message : '保存に失敗', true);
        }
    });

    cancel?.addEventListener('click', () => {
        resetForm();
        setStatus('');
    });

    worldSel?.addEventListener('change', () => {
        resetForm();
        void reloadWorldViewer();
        renderTable();
    });

    reloadBtn?.addEventListener('click', () => void reloadWorldViewer());

    newBtn?.addEventListener('click', () => {
        resetForm();
        void ensureWorldPlacer().then((p) => {
            const world = worldsData[getSelectedWorldId()];
            if (p && world) p.focusDefaultSpawn(world);
        });
    });

    yawInput?.addEventListener('input', () => {
        const yaw = parseFloat(/** @type {HTMLInputElement} */ (yawInput).value);
        if (Number.isFinite(yaw) && worldPlacer) worldPlacer.setPlacementYaw(yaw);
    });

    typeSel?.addEventListener('change', () => {
        syncTypeUi();
        scheduleBakePreviewRefresh();
    });

    radiusInput?.addEventListener('input', () => {
        const radiusVal = document.getElementById('nfc-spawn-load-radius-val');
        if (radiusVal) radiusVal.textContent = `${getLoadRadius()} m`;
        if (worldPlacer) worldPlacer.setLoadRadius(getLoadRadius());
        scheduleBakePreviewRefresh();
    });

    bakeBtn?.addEventListener('click', async () => {
        if (getSelectedType() !== 'instance') return;
        if (!canUseInstanceBakeDraft()) {
            setStatus('3D で位置を決め、半径を設定してください', true);
            return;
        }
        if (!window.confirm('インスタンスを保存してベイクしますか？')) return;
        bakeBtn.disabled = true;
        setStatus('保存・ベイク中…');
        try {
            const j = await apiFetch(`${API_BASE}/bake`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(readBakeRequestBody()),
            });
            if (j.spawn) fillForm(j.spawn);
            setStatus(`ベイク完了（${j.bake?.entryCount ?? 0} 件）`);
            await refreshNfcSpawnPanel();
        } catch (e) {
            setStatus(e instanceof Error ? e.message : 'ベイクに失敗', true);
        } finally {
            bakeBtn.disabled = false;
        }
    });

    copyUrlBtn?.addEventListener('click', async () => {
        const url = resolveCopyUrl('spawn');
        if (!url) {
            setStatus('先に保存してトークンを発行してください', true);
            return;
        }
        const ok = await copyText(url);
        setStatus(ok ? 'テレポート URL をコピーしました' : 'コピーに失敗しました', !ok);
    });

    const handleCopyInstanceUrl = async () => {
        const url = resolveCopyUrl('instance');
        if (!url) {
            setStatus('先に保存してトークンを発行してください', true);
            return;
        }
        const ok = await copyText(url);
        if (ok) {
            const urlDisplay = /** @type {HTMLInputElement|null} */ (
                document.getElementById('nfc-spawn-instance-url-display')
            );
            if (urlDisplay) urlDisplay.value = url;
        }
        setStatus(ok ? 'インスタンス URL をコピーしました' : 'コピーに失敗しました', !ok);
    };

    copyInstBtn?.addEventListener('click', () => void handleCopyInstanceUrl());

    const urlDisplay = document.getElementById('nfc-spawn-instance-url-display');
    urlDisplay?.addEventListener('click', () => {
        urlDisplay.select();
    });

    regenBtn?.addEventListener('click', async () => {
        if (editingId == null) return;
        if (!window.confirm('トークンを再発行しますか？旧 URL は使えなくなります。')) return;
        try {
            const j = await apiFetch(`${API_BASE}/${editingId}/regenerate-token`, { method: 'POST' });
            if (j.spawn) fillForm(j.spawn);
            setStatus('トークンを再発行しました');
            await refreshNfcSpawnPanel();
        } catch (e) {
            setStatus(e instanceof Error ? e.message : '再発行に失敗', true);
        }
    });
}

function initNfcSpawnAdmin() {
    ensurePanelDom();
    bindForm();
    injectAdminStyles();
    document.addEventListener('admin-panel-activated', (e) => {
        if (e.detail?.panelId === NAV_DATA_PANEL) void refreshNfcSpawnPanel();
    });
    document.addEventListener('admin-panel-request', (e) => {
        if (e.detail?.panelId === NAV_DATA_PANEL) showNfcSpawnPanel();
    });
}

function injectAdminStyles() {
    if (document.getElementById('nfc-spawn-admin-styles')) return;
    const style = document.createElement('style');
    style.id = 'nfc-spawn-admin-styles';
    style.textContent = `
        .admin-nav-item .nfc-admin-nav-svg { vertical-align: -0.15em; margin-right: 0.35em; flex-shrink: 0; }
        .admin-sidebar.collapsed .admin-nav-item .nfc-admin-nav-svg { margin-right: 0; }
        .admin-nav-item { display: flex; align-items: center; }
        .nfc-spawn-toolbar { display: flex; flex-wrap: wrap; gap: 0.75rem; align-items: flex-end; margin-bottom: 1rem; }
        .nfc-spawn-toolbar-world { min-width: 200px; margin: 0; }
        .nfc-spawn-main-layout { display: grid; grid-template-columns: minmax(0, 1.4fr) minmax(280px, 1fr); gap: 1rem; align-items: start; }
        @media (max-width: 1100px) { .nfc-spawn-main-layout { grid-template-columns: 1fr; } }
        .nfc-spawn-viewer-wrap { display: flex; flex-direction: column; gap: 0.35rem; min-width: 0; }
        .nfc-spawn-viewer-mount { width: 100%; height: min(52vh, 520px); min-height: 280px; background: #1a1a22; border: 1px solid var(--admin-border, #444); border-radius: 6px; overflow: hidden; }
        .nfc-spawn-viewer-hint { margin: 0; font-size: 0.85rem; }
        .nfc-spawn-side { display: flex; flex-direction: column; gap: 1rem; min-width: 0; }
        .nfc-spawn-form-card { padding: 0.75rem 1rem; border: 1px solid var(--admin-border, #444); border-radius: 6px; background: var(--admin-card-bg, rgba(0,0,0,0.15)); }
        .nfc-spawn-form { display: flex; flex-direction: column; gap: 0.65rem; }
        .nfc-spawn-label { display: flex; flex-direction: column; gap: 0.25rem; font-size: 0.9rem; }
        .nfc-spawn-label input, .nfc-spawn-label select { width: 100%; }
        .nfc-spawn-coords { display: grid; grid-template-columns: repeat(2, 1fr); gap: 0.5rem; }
        .nfc-spawn-coords label { display: flex; flex-direction: column; gap: 0.2rem; font-size: 0.85rem; }
        .nfc-spawn-coords input[readonly] { opacity: 0.85; cursor: default; }
        .nfc-spawn-check { display: flex; align-items: center; gap: 0.5rem; }
        .nfc-spawn-form-actions { display: flex; gap: 0.5rem; flex-wrap: wrap; }
        .nfc-spawn-edit-meta { margin-top: 0.75rem; padding-top: 0.75rem; border-top: 1px solid var(--admin-border, #444); font-size: 0.88rem; }
        .nfc-spawn-edit-meta p { margin: 0.25rem 0; }
        .nfc-spawn-instance-url-wrap { display: flex; flex-direction: column; gap: 0.35rem; margin: 0.5rem 0; }
        .nfc-spawn-url-row { display: flex; gap: 0.35rem; align-items: center; }
        .nfc-spawn-url-input { flex: 1; min-width: 0; font-size: 0.82rem; }
        .nfc-spawn-token-code { word-break: break-all; font-size: 0.8rem; }
        .nfc-spawn-meta-actions { display: flex; gap: 0.35rem; flex-wrap: wrap; margin-top: 0.5rem; }
        .nfc-spawn-table-wrap h3 { margin-bottom: 0.5rem; }
        .nfc-spawn-list-count { font-weight: normal; color: #888; font-size: 0.9em; }
        .nfc-spawn-table-scroll { max-height: 280px; overflow: auto; }
        .nfc-spawn-table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
        .nfc-spawn-table th, .nfc-spawn-table td { border: 1px solid var(--admin-border, #444); padding: 0.35rem 0.45rem; text-align: left; }
        .nfc-spawn-row-selected { background: rgba(68, 170, 255, 0.12); }
        .nfc-spawn-actions { display: flex; flex-wrap: wrap; gap: 0.25rem; }
        .nfc-spawn-empty { text-align: center; color: #888; }
        .nfc-spawn-instance-fields { display: flex; flex-direction: column; gap: 0.5rem; padding: 0.5rem 0; border-top: 1px dashed var(--admin-border, #444); }
        .nfc-spawn-bake-preview { list-style: none; margin: 0; padding: 0; max-height: 140px; overflow: auto; font-size: 0.82rem; }
        .nfc-spawn-bake-preview li { padding: 0.2rem 0; }
        .nfc-spawn-preview-part { padding-left: 0.25rem; }
        .nfc-spawn-part-idx { opacity: 0.65; font-size: 0.78rem; }
        .nfc-spawn-preview-hint { color: #888; }
        .nfc-spawn-bake-status { font-size: 0.85rem; margin: 0; color: #aaa; }
        .btn-sm { padding: 0.2rem 0.5rem; font-size: 0.8rem; }
    `;
    document.head.appendChild(style);
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initNfcSpawnAdmin);
} else {
    initNfcSpawnAdmin();
}
