// addons/nfc-spawn/client/admin.js — 管理画面に NFCタグパネル（3Dワールド配置付き）
import { adminFetch } from '/js/admin-api-fetch.js';

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

/** @type {string|null} 3D に読み込み済みのワールド ID */
let loadedWorldId = null;

/**
 * @param {string} path
 * @param {RequestInit} [init]
 */
async function apiFetch(path, init) {
    const r = await adminFetch(path, { credentials: 'include', ...init });
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
            <header class="nfc-spawn-header">
                <h2>NFCタグ・スポーン地点</h2>
                <p class="hint nfc-spawn-lead">3D プレビュー上の<strong>緑マーカー</strong>をドラッグして位置を決めます。<strong>テレポート</strong>は <code>/?spawn=TOKEN</code>、<strong>インスタンス</strong>は <code>/instance/?token=TOKEN</code> です。</p>
            </header>

            <div class="nfc-spawn-world-bar">
                <label class="nfc-spawn-label nfc-spawn-world-select">
                    <span class="nfc-spawn-field-label">ワールド</span>
                    <select id="nfc-spawn-world" class="nfc-spawn-select">
                        <option value="">ワールドを選択…</option>
                    </select>
                </label>
                <div class="nfc-spawn-world-actions">
                    <button type="button" class="btn btn-primary" id="nfc-spawn-show-world">表示</button>
                    <button type="button" class="btn btn-secondary" id="nfc-spawn-reload-world" disabled title="読み込み済みワールドを再取得">再読込</button>
                    <button type="button" class="btn btn-secondary" id="nfc-spawn-new-btn">新規配置</button>
                </div>
                <span id="nfc-spawn-loaded-badge" class="nfc-spawn-loaded-badge" hidden></span>
            </div>
            <p id="nfc-spawn-status" class="nfc-spawn-status status-text" role="status"></p>

            <div class="nfc-spawn-main-layout">
                <div class="nfc-spawn-viewer-wrap">
                    <div id="nfc-spawn-viewer-mount" class="nfc-spawn-viewer-mount" aria-label="ワールド3Dプレビュー">
                        <div id="nfc-spawn-viewer-placeholder" class="nfc-spawn-viewer-placeholder">
                            <i class="bi bi-box" aria-hidden="true"></i>
                            <p>ワールドを選択して「表示」を押すと<br>3D プレビューが開きます</p>
                        </div>
                    </div>
                    <p class="hint nfc-spawn-viewer-hint">マーカーをドラッグして移動・Yaw で向きを調整</p>
                </div>

                <div class="nfc-spawn-side">
                    <div class="nfc-spawn-form-card">
                        <h3 id="nfc-spawn-form-title" class="nfc-spawn-card-title">新規 NFC タグ</h3>
                        <form id="nfc-spawn-form" class="nfc-spawn-form">
                            <input type="hidden" id="nfc-spawn-edit-id" value="">
                            <fieldset class="nfc-spawn-fieldset">
                                <legend>基本</legend>
                                <label class="nfc-spawn-label">タイプ
                                    <select id="nfc-spawn-type" class="nfc-spawn-select">
                                        <option value="teleport">テレポート（フルメタバース）</option>
                                        <option value="instance">インスタンス（スマホ閲覧専用）</option>
                                    </select>
                                </label>
                                <label class="nfc-spawn-label">ラベル
                                    <input type="text" id="nfc-spawn-label" class="nfc-spawn-input" required maxlength="128" placeholder="図書館模型">
                                </label>
                                <label class="nfc-spawn-check">
                                    <input type="checkbox" id="nfc-spawn-enabled" checked> 有効
                                </label>
                            </fieldset>
                            <div id="nfc-spawn-instance-fields" class="nfc-spawn-instance-fields" hidden>
                                <fieldset class="nfc-spawn-fieldset">
                                    <legend>インスタンス設定</legend>
                                    <label class="nfc-spawn-label">ロード半径 (m)
                                        <div class="nfc-spawn-range-row">
                                            <input type="range" id="nfc-spawn-load-radius" min="1" max="100" step="1" value="15">
                                            <span id="nfc-spawn-load-radius-val" class="nfc-spawn-range-val">15 m</span>
                                        </div>
                                    </label>
                                    <div class="nfc-spawn-bake-preview-wrap">
                                        <h4 class="nfc-spawn-subheading">球内モデル（パーツ単位プレビュー）</h4>
                                        <ul id="nfc-spawn-bake-preview" class="nfc-spawn-bake-preview"></ul>
                                    </div>
                                    <p id="nfc-spawn-bake-status" class="nfc-spawn-bake-status"></p>
                                    <button type="button" class="btn btn-secondary" id="nfc-spawn-bake-btn">インスタンスを生成 / 再ベイク</button>
                                </fieldset>
                            </div>
                            <fieldset class="nfc-spawn-fieldset">
                                <legend>位置</legend>
                                <div class="nfc-spawn-coords">
                                    <label>X <input type="number" id="nfc-spawn-x" class="nfc-spawn-input" step="any" value="0" readonly></label>
                                    <label>Y <input type="number" id="nfc-spawn-y" class="nfc-spawn-input" step="any" value="10" readonly></label>
                                    <label>Z <input type="number" id="nfc-spawn-z" class="nfc-spawn-input" step="any" value="0" readonly></label>
                                    <label>Yaw° <input type="number" id="nfc-spawn-yaw" class="nfc-spawn-input" step="any" value="0"></label>
                                </div>
                                <p class="hint nfc-spawn-coords-hint">座標は 3D プレビューでマーカーを動かすと更新されます</p>
                            </fieldset>
                            <label class="nfc-spawn-label">NFC UID（任意・メモ）
                                <input type="text" id="nfc-spawn-uid" class="nfc-spawn-input" maxlength="64" placeholder="04:AB:...">
                            </label>
                            <div class="nfc-spawn-form-actions">
                                <button type="submit" class="btn btn-primary" id="nfc-spawn-save-btn">NFCタグを追加</button>
                                <button type="button" class="btn btn-secondary" id="nfc-spawn-cancel-btn" hidden>キャンセル</button>
                            </div>
                        </form>
                        <div id="nfc-spawn-edit-meta" class="nfc-spawn-edit-meta" hidden>
                            <h4 class="nfc-spawn-subheading">登録情報</h4>
                            <dl class="nfc-spawn-meta-dl">
                                <dt>ID</dt><dd id="nfc-spawn-meta-id">-</dd>
                                <dt>トークン</dt><dd><code id="nfc-spawn-meta-token" class="nfc-spawn-token-code">-</code></dd>
                            </dl>
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
                        <h3 class="nfc-spawn-card-title">登録一覧 <span id="nfc-spawn-list-count" class="nfc-spawn-list-count"></span></h3>
                        <p id="nfc-spawn-table-hint" class="hint nfc-spawn-table-hint">ワールドを選択すると一覧が表示されます</p>
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
    return String(
        /** @type {HTMLSelectElement} */ (document.getElementById('nfc-spawn-world'))?.value || ''
    ).trim();
}

/**
 * 選択中のワールドが 3D に読み込み済みか
 */
function isWorldViewerReady() {
    const selected = getSelectedWorldId();
    return Boolean(selected && loadedWorldId === selected && worldPlacer);
}

/**
 * ビューアのプレースホルダーと再読込ボタンを同期
 */
function syncViewerChrome() {
    const mount = document.getElementById('nfc-spawn-viewer-mount');
    const placeholder = document.getElementById('nfc-spawn-viewer-placeholder');
    const reloadBtn = document.getElementById('nfc-spawn-reload-world');
    const badge = document.getElementById('nfc-spawn-loaded-badge');
    const ready = isWorldViewerReady();

    mount?.classList.toggle('nfc-spawn-viewer-mount--ready', ready);
    if (placeholder) placeholder.hidden = ready;
    if (reloadBtn) reloadBtn.disabled = !ready;
    if (badge) {
        if (ready && loadedWorldId) {
            badge.hidden = false;
            badge.textContent = `表示中: ${loadedWorldId}`;
        } else {
            badge.hidden = true;
            badge.textContent = '';
        }
    }
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
    if (isWorldViewerReady() && worldPlacer) {
        const p = worldPlacer;
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
    }
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
    if (!isWorldViewerReady()) return false;
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
            '<li class="nfc-spawn-preview-hint">ワールドを表示し、3D で位置を決めてください</li>';
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
 * 選択ワールドの 3D とマーカーを読み込む（「表示」ボタン用）
 */
async function loadWorldViewer() {
    const worldId = getSelectedWorldId();
    if (!worldId) {
        setStatus('ワールドを選択してください', true);
        return;
    }
    const placer = await ensureWorldPlacer();
    if (!placer) return;
    const showBtn = document.getElementById('nfc-spawn-show-world');
    if (showBtn) showBtn.disabled = true;
    setStatus('ワールドを読み込み中…');
    try {
        const world = worldsData[worldId];
        if (!world) {
            setStatus('ワールドデータが見つかりません', true);
            return;
        }
        await placer.loadWorld(world);
        loadedWorldId = worldId;
        refreshWorldMarkers();
        syncTypeUi();
        syncViewerChrome();
        if (!editingId) {
            placer.focusDefaultSpawn(world);
        } else {
            const row = spawns.find((s) => s.id === editingId);
            if (row) {
                placer.showPlacementMarker({ x: row.x, y: row.y, z: row.z, yaw: row.yaw ?? 0 });
            }
        }
        setStatus('');
    } catch (e) {
        loadedWorldId = null;
        syncViewerChrome();
        setStatus(e instanceof Error ? e.message : 'ワールド読込失敗', true);
    } finally {
        if (showBtn) showBtn.disabled = false;
    }
}

/**
 * 読み込み済みワールドを再取得
 */
async function reloadWorldViewer() {
    if (!isWorldViewerReady()) {
        await loadWorldViewer();
        return;
    }
    await loadWorldViewer();
}

/**
 * 現在ワールドのタグマーカーを 3D に反映
 */
function refreshWorldMarkers() {
    if (!worldPlacer || !isWorldViewerReady()) return;
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
    const options = worldIds
        .map((id) => `<option value="${escapeHtml(id)}">${escapeHtml(id)}</option>`)
        .join('');
    sel.innerHTML = `<option value="">ワールドを選択…</option>${options}`;
    if (prev && worldIds.includes(prev)) sel.value = prev;
    else sel.value = '';
    if (prev && loadedWorldId && prev !== loadedWorldId) {
        loadedWorldId = null;
        worldPlacer?.unloadWorld?.();
        syncViewerChrome();
    }
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
        if (!p || !isWorldViewerReady()) return;
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
        renderTable();
    }
    if (row.world_id && row.world_id !== loadedWorldId) {
        fillForm(row);
        setStatus('別ワールドのタグです。「表示」でワールドを読み込んでください', true);
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
        if (!p || !isWorldViewerReady()) return;
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
    const hintEl = document.getElementById('nfc-spawn-table-hint');
    const worldId = getSelectedWorldId();
    if (hintEl) {
        hintEl.hidden = Boolean(worldId);
        hintEl.textContent = worldId ? '' : 'ワールドを選択すると一覧が表示されます';
    }
    if (!worldId) {
        if (countEl) countEl.textContent = '';
        if (tbody) tbody.innerHTML = '<tr><td colspan="6" class="nfc-spawn-empty">ワールド未選択</td></tr>';
        return;
    }
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
            const typeClass = row.type === 'instance' ? 'nfc-type-instance' : 'nfc-type-teleport';
            const typeLabel = row.type === 'instance' ? 'インスタンス' : 'テレポート';
            const sel = row.id === editingId ? ' class="nfc-spawn-row-selected"' : '';
            return `<tr data-id="${row.id}"${sel}>
                <td><span class="nfc-spawn-type-badge ${typeClass}">${typeLabel}</span></td>
                <td><code>${row.id}</code></td>
                <td>${escapeHtml(row.label)}</td>
                <td><code>${escapeHtml(coord)}</code></td>
                <td>${enabledMark}</td>
                <td class="nfc-spawn-actions">
                    <button type="button" class="btn btn-secondary btn-sm nfc-locate">選択</button>
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
                if (isWorldViewerReady()) await reloadWorldViewer();
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
        syncViewerChrome();
    } catch (e) {
        setStatus(e instanceof Error ? e.message : '読み込みに失敗', true);
    }
}

function bindForm() {
    const form = document.getElementById('nfc-spawn-form');
    const cancel = document.getElementById('nfc-spawn-cancel-btn');
    const worldSel = document.getElementById('nfc-spawn-world');
    const showWorldBtn = document.getElementById('nfc-spawn-show-world');
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
        if (!body.world_id) {
            setStatus('ワールドを選択してください', true);
            return;
        }
        if (!isWorldViewerReady()) {
            setStatus('先に「表示」でワールドを読み込んでください', true);
            return;
        }
        if (![body.x, body.y, body.z].every((n) => Number.isFinite(n))) {
            setStatus('ワールドを表示し、3D で位置を決めてください', true);
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
            if (isWorldViewerReady()) await reloadWorldViewer();
        } catch (err) {
            setStatus(err instanceof Error ? err.message : '保存に失敗', true);
        }
    });

    cancel?.addEventListener('click', () => {
        resetForm();
        setStatus('');
    });

    worldSel?.addEventListener('change', () => {
        const selected = getSelectedWorldId();
        if (loadedWorldId && selected !== loadedWorldId) {
            loadedWorldId = null;
            worldPlacer?.unloadWorld?.();
        }
        resetForm();
        renderTable();
        syncViewerChrome();
        setStatus('');
    });

    showWorldBtn?.addEventListener('click', () => void loadWorldViewer());

    reloadBtn?.addEventListener('click', () => void reloadWorldViewer());

    newBtn?.addEventListener('click', () => {
        if (!getSelectedWorldId()) {
            setStatus('ワールドを選択してください', true);
            return;
        }
        if (!isWorldViewerReady()) {
            setStatus('先に「表示」でワールドを読み込んでください', true);
            return;
        }
        resetForm();
        const world = worldsData[getSelectedWorldId()];
        if (worldPlacer && world) worldPlacer.focusDefaultSpawn(world);
    });

    yawInput?.addEventListener('input', () => {
        const yaw = parseFloat(/** @type {HTMLInputElement} */ (yawInput).value);
        if (Number.isFinite(yaw) && isWorldViewerReady() && worldPlacer) {
            worldPlacer.setPlacementYaw(yaw);
        }
    });

    typeSel?.addEventListener('change', () => {
        syncTypeUi();
        scheduleBakePreviewRefresh();
    });

    radiusInput?.addEventListener('input', () => {
        const radiusVal = document.getElementById('nfc-spawn-load-radius-val');
        if (radiusVal) radiusVal.textContent = `${getLoadRadius()} m`;
        if (isWorldViewerReady() && worldPlacer) worldPlacer.setLoadRadius(getLoadRadius());
        scheduleBakePreviewRefresh();
    });

    bakeBtn?.addEventListener('click', async () => {
        if (getSelectedType() !== 'instance') return;
        if (!isWorldViewerReady()) {
            setStatus('先に「表示」でワールドを読み込んでください', true);
            return;
        }
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
            if (isWorldViewerReady()) await reloadWorldViewer();
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
            if (isWorldViewerReady()) await reloadWorldViewer();
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
        .nfc-spawn-section { max-width: 1400px; }
        .nfc-spawn-header { margin-bottom: 1rem; }
        .nfc-spawn-header h2 { margin: 0 0 0.35rem; font-size: 1.35rem; }
        .nfc-spawn-lead { margin: 0; font-size: 0.92rem; line-height: 1.55; }
        .nfc-spawn-world-bar {
            display: flex; flex-wrap: wrap; gap: 0.75rem 1rem; align-items: flex-end;
            padding: 0.85rem 1rem; margin-bottom: 0.75rem;
            border: 1px solid var(--admin-border, #ddd); border-radius: 8px;
            background: var(--admin-card-bg, #f8f9fb);
        }
        .nfc-spawn-world-select { flex: 1 1 220px; min-width: 200px; margin: 0; }
        .nfc-spawn-field-label { font-size: 0.8rem; font-weight: 600; color: #666; text-transform: uppercase; letter-spacing: 0.03em; }
        .nfc-spawn-world-actions { display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: center; }
        .nfc-spawn-loaded-badge {
            flex: 1 1 100%; font-size: 0.82rem; color: #1565c0;
            padding: 0.25rem 0.5rem; background: rgba(21, 101, 192, 0.08); border-radius: 4px;
        }
        .nfc-spawn-status { min-height: 1.25rem; margin: 0 0 0.75rem; font-size: 0.9rem; }
        .nfc-spawn-status.error { color: #c62828; }
        .nfc-spawn-main-layout { display: grid; grid-template-columns: minmax(0, 1.35fr) minmax(300px, 1fr); gap: 1rem; align-items: start; }
        @media (max-width: 1100px) { .nfc-spawn-main-layout { grid-template-columns: 1fr; } }
        .nfc-spawn-viewer-wrap { display: flex; flex-direction: column; gap: 0.35rem; min-width: 0; }
        .nfc-spawn-viewer-mount {
            position: relative; width: 100%; height: min(56vh, 540px); min-height: 300px;
            background: #1a1a22; border: 1px solid var(--admin-border, #ccc); border-radius: 8px; overflow: hidden;
        }
        .nfc-spawn-viewer-placeholder {
            position: absolute; inset: 0; z-index: 1; display: flex; flex-direction: column;
            align-items: center; justify-content: center; gap: 0.65rem; padding: 1.5rem;
            color: #9aa3b2; text-align: center; pointer-events: none;
            background: linear-gradient(160deg, #1e2430 0%, #141820 100%);
        }
        .nfc-spawn-viewer-placeholder .bi { font-size: 2rem; opacity: 0.55; }
        .nfc-spawn-viewer-placeholder p { margin: 0; font-size: 0.9rem; line-height: 1.5; }
        .nfc-spawn-viewer-mount--ready .nfc-spawn-viewer-placeholder { display: none; }
        .nfc-spawn-viewer-mount canvas { position: relative; z-index: 2; }
        .nfc-spawn-viewer-hint { margin: 0; font-size: 0.82rem; color: #777; }
        .nfc-spawn-side { display: flex; flex-direction: column; gap: 1rem; min-width: 0; }
        .nfc-spawn-form-card, .nfc-spawn-table-wrap {
            padding: 1rem 1.1rem; border: 1px solid var(--admin-border, #ddd); border-radius: 8px;
            background: #fff;
        }
        .nfc-spawn-card-title { margin: 0 0 0.75rem; font-size: 1.05rem; font-weight: 600; }
        .nfc-spawn-subheading { margin: 0 0 0.5rem; font-size: 0.88rem; font-weight: 600; color: #555; }
        .nfc-spawn-form { display: flex; flex-direction: column; gap: 0.75rem; }
        .nfc-spawn-fieldset {
            margin: 0; padding: 0.65rem 0.75rem; border: 1px solid var(--admin-border, #e8e8e8);
            border-radius: 6px; display: flex; flex-direction: column; gap: 0.6rem;
        }
        .nfc-spawn-fieldset legend {
            padding: 0 0.35rem; font-size: 0.78rem; font-weight: 600; color: #666;
            text-transform: uppercase; letter-spacing: 0.04em;
        }
        .nfc-spawn-label { display: flex; flex-direction: column; gap: 0.3rem; font-size: 0.9rem; margin: 0; }
        .nfc-spawn-input, .nfc-spawn-select {
            width: 100%; padding: 0.4rem 0.55rem; border: 1px solid #ccc; border-radius: 4px; font-size: 0.9rem;
        }
        .nfc-spawn-range-row { display: flex; align-items: center; gap: 0.65rem; }
        .nfc-spawn-range-row input[type="range"] { flex: 1; }
        .nfc-spawn-range-val { min-width: 3rem; font-size: 0.85rem; color: #555; }
        .nfc-spawn-coords { display: grid; grid-template-columns: repeat(2, 1fr); gap: 0.5rem; }
        .nfc-spawn-coords label { display: flex; flex-direction: column; gap: 0.2rem; font-size: 0.85rem; }
        .nfc-spawn-coords input[readonly] { background: #f5f5f5; cursor: default; }
        .nfc-spawn-coords-hint { margin: 0; font-size: 0.78rem; }
        .nfc-spawn-check { display: flex; align-items: center; gap: 0.5rem; font-size: 0.9rem; }
        .nfc-spawn-form-actions { display: flex; gap: 0.5rem; flex-wrap: wrap; padding-top: 0.15rem; }
        .nfc-spawn-edit-meta { margin-top: 0.5rem; padding-top: 0.75rem; border-top: 1px solid var(--admin-border, #e0e0e0); }
        .nfc-spawn-meta-dl { display: grid; grid-template-columns: auto 1fr; gap: 0.25rem 0.75rem; margin: 0 0 0.5rem; font-size: 0.88rem; }
        .nfc-spawn-meta-dl dt { color: #666; font-weight: 600; }
        .nfc-spawn-meta-dl dd { margin: 0; }
        .nfc-spawn-instance-url-wrap { display: flex; flex-direction: column; gap: 0.35rem; margin: 0.5rem 0; font-size: 0.88rem; }
        .nfc-spawn-url-row { display: flex; gap: 0.35rem; align-items: center; }
        .nfc-spawn-url-input { flex: 1; min-width: 0; font-size: 0.82rem; }
        .nfc-spawn-token-code { word-break: break-all; font-size: 0.8rem; }
        .nfc-spawn-meta-actions { display: flex; gap: 0.35rem; flex-wrap: wrap; }
        .nfc-spawn-table-hint { margin: -0.35rem 0 0.5rem; font-size: 0.82rem; }
        .nfc-spawn-list-count { font-weight: normal; color: #888; font-size: 0.9em; }
        .nfc-spawn-table-scroll { max-height: 300px; overflow: auto; border: 1px solid var(--admin-border, #eee); border-radius: 4px; }
        .nfc-spawn-table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
        .nfc-spawn-table th {
            position: sticky; top: 0; z-index: 1;
            background: #f5f5f5; border-bottom: 1px solid var(--admin-border, #ddd);
            padding: 0.45rem 0.5rem; text-align: left; font-size: 0.8rem;
        }
        .nfc-spawn-table td { border-bottom: 1px solid var(--admin-border, #eee); padding: 0.4rem 0.5rem; text-align: left; vertical-align: middle; }
        .nfc-spawn-row-selected { background: rgba(21, 101, 192, 0.08); }
        .nfc-spawn-type-badge {
            display: inline-block; padding: 0.12rem 0.45rem; border-radius: 999px;
            font-size: 0.75rem; font-weight: 600; white-space: nowrap;
        }
        .nfc-spawn-type-badge.nfc-type-teleport { background: #e3f2fd; color: #1565c0; }
        .nfc-spawn-type-badge.nfc-type-instance { background: #f3e5f5; color: #7b1fa2; }
        .nfc-spawn-actions { display: flex; flex-wrap: wrap; gap: 0.25rem; }
        .nfc-spawn-empty { text-align: center; color: #888; padding: 1rem !important; }
        .nfc-spawn-instance-fields { display: flex; flex-direction: column; gap: 0.5rem; }
        .nfc-spawn-bake-preview { list-style: none; margin: 0; padding: 0; max-height: 140px; overflow: auto; font-size: 0.82rem; }
        .nfc-spawn-bake-preview li { padding: 0.2rem 0; }
        .nfc-spawn-preview-part { padding-left: 0.25rem; }
        .nfc-spawn-part-idx { opacity: 0.65; font-size: 0.78rem; }
        .nfc-spawn-preview-hint { color: #888; }
        .nfc-spawn-bake-status { font-size: 0.85rem; margin: 0; color: #777; }
        .btn-sm { padding: 0.2rem 0.5rem; font-size: 0.8rem; }
        body.admin-dark .nfc-spawn-world-bar { background: rgba(255,255,255,0.04); }
        body.admin-dark .nfc-spawn-form-card, body.admin-dark .nfc-spawn-table-wrap { background: rgba(255,255,255,0.03); }
        body.admin-dark .nfc-spawn-fieldset { border-color: rgba(255,255,255,0.1); }
        body.admin-dark .nfc-spawn-coords input[readonly] { background: rgba(0,0,0,0.2); }
        body.admin-dark .nfc-spawn-table th { background: rgba(255,255,255,0.06); }
    `;
    document.head.appendChild(style);
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initNfcSpawnAdmin);
} else {
    initNfcSpawnAdmin();
}
