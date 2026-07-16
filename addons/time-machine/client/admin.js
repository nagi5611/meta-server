// addons/time-machine/client/admin.js — タイムマシン管理パネル
import { adminFetch } from '/js/admin-api-fetch.js';

const PANEL_ID = 'panel-addon-time-machine';
const NAV_DATA_PANEL = 'panel-addon-time-machine';
const API = '/admin/addons/time-machine';

/**
 * @param {string} path
 * @param {RequestInit} [init]
 */
async function apiFetch(path, init) {
    const r = await adminFetch(path, { credentials: 'include', ...init });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
    return j;
}

/**
 * @param {number} bytes
 * @returns {string}
 */
function formatBytes(bytes) {
    if (!bytes || bytes < 0) return '-';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
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

function ensurePanelDom() {
    if (document.getElementById(PANEL_ID)) return;

    const nav = document.querySelector('.admin-nav');
    const panels = document.querySelector('.admin-panels');
    if (!nav || !panels) return;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'admin-nav-item';
    btn.dataset.panel = NAV_DATA_PANEL;
    btn.innerHTML = '<i class="bi bi-clock-history" aria-hidden="true"></i><span>タイムマシン</span>';
    const addonsBtn = nav.querySelector('[data-panel="panel-addons"]');
    if (addonsBtn) nav.insertBefore(btn, addonsBtn);
    else nav.appendChild(btn);

    const panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.className = 'admin-panel';
    panel.innerHTML = `
        <section class="tm-section">
            <header class="tm-header">
                <h2>タイムマシン</h2>
                <p class="hint tm-lead">マウント HDD への状態バックアップ（hourly）とフルバックアップ（daily）。ロールバック後は CloudFront 無効化を実行してください。</p>
            </header>
            <p id="tm-status" class="status-text" role="status"></p>

            <div class="tm-card">
                <h3>ストレージ設定</h3>
                <div class="table-responsive">
                    <table class="tm-table" id="tm-storages-table">
                        <thead>
                            <tr>
                                <th>ID</th>
                                <th>パス</th>
                                <th>状態</th>
                                <th>役割</th>
                                <th>hourly保持</th>
                                <th>daily保持</th>
                                <th>daily時刻</th>
                                <th>有効</th>
                                <th></th>
                            </tr>
                        </thead>
                        <tbody id="tm-storages-tbody"></tbody>
                    </table>
                </div>
            </div>

            <div class="tm-card">
                <h3>即時バックアップ</h3>
                <div class="tm-row">
                    <label>範囲
                        <select id="tm-backup-scope" class="tm-select">
                            <option value="state">state（data + db + .env）</option>
                            <option value="addons">addons/</option>
                            <option value="server_src">server_src（META_SRC_DIRECTORY）</option>
                            <option value="full">full（server_src + .env）</option>
                        </select>
                    </label>
                    <label>ストレージ
                        <select id="tm-backup-mount" class="tm-select"></select>
                    </label>
                    <button type="button" class="btn btn-primary" id="tm-backup-run-btn">実行</button>
                </div>
            </div>

            <div class="tm-card">
                <h3>スナップショット</h3>
                <div class="tm-row">
                    <label>ストレージ
                        <select id="tm-snap-mount" class="tm-select"></select>
                    </label>
                    <label>種別
                        <select id="tm-snap-kind" class="tm-select">
                            <option value="">すべて</option>
                            <option value="hourly">hourly</option>
                            <option value="daily">daily</option>
                        </select>
                    </label>
                    <button type="button" class="btn btn-secondary" id="tm-snap-refresh-btn">更新</button>
                </div>
                <div class="table-responsive">
                    <table class="tm-table">
                        <thead>
                            <tr>
                                <th>ID</th>
                                <th>種別</th>
                                <th>作成</th>
                                <th>サイズ</th>
                                <th>操作</th>
                            </tr>
                        </thead>
                        <tbody id="tm-snapshots-tbody"></tbody>
                    </table>
                </div>
            </div>

            <div class="tm-card">
                <h3>CloudFront キャッシュ</h3>
                <p class="hint">ロールバック・S3 同期後に実行してください。</p>
                <button type="button" class="btn btn-secondary" id="tm-cf-invalidate-btn">アセット CDN を無効化</button>
            </div>

            <div class="tm-card">
                <h3>直近ジョブ</h3>
                <div class="table-responsive">
                    <table class="tm-table">
                        <thead>
                            <tr>
                                <th>時刻</th>
                                <th>種別</th>
                                <th>範囲</th>
                                <th>mount</th>
                                <th>状態</th>
                                <th>サイズ</th>
                            </tr>
                        </thead>
                        <tbody id="tm-runs-tbody"></tbody>
                    </table>
                </div>
            </div>
        </section>
    `;
    panels.appendChild(panel);

    injectStyles();
    bindEvents();
}

function injectStyles() {
    if (document.getElementById('tm-admin-styles')) return;
    const style = document.createElement('style');
    style.id = 'tm-admin-styles';
    style.textContent = `
        .tm-section { max-width: 1100px; }
        .tm-lead { margin-bottom: 1rem; }
        .tm-card { margin-bottom: 1.5rem; padding: 1rem; border: 1px solid var(--border-color, #333); border-radius: 8px; }
        .tm-card h3 { margin-top: 0; }
        .tm-row { display: flex; flex-wrap: wrap; gap: 0.75rem; align-items: flex-end; margin-bottom: 0.5rem; }
        .tm-select { min-width: 10rem; }
        .tm-table { width: 100%; border-collapse: collapse; font-size: 0.9rem; }
        .tm-table th, .tm-table td { padding: 0.4rem 0.5rem; border-bottom: 1px solid var(--border-color, #333); text-align: left; }
        .tm-table code { font-size: 0.85em; }
        .tm-pin-modal { position: fixed; inset: 0; background: rgba(0,0,0,0.5); display: flex; align-items: center; justify-content: center; z-index: 9999; }
        .tm-pin-dialog { background: var(--panel-bg, #1a1a1a); padding: 1.25rem; border-radius: 8px; min-width: 280px; }
    `;
    document.head.appendChild(style);
}

/**
 * @param {string} text
 * @param {boolean} [isError]
 */
function setStatus(text, isError = false) {
    const el = document.getElementById('tm-status');
    if (!el) return;
    el.textContent = text;
    el.classList.toggle('error', isError);
}

/** @type {Array<object>} */
let cachedStorages = [];

async function loadStorages() {
    const j = await apiFetch(`${API}/storages`);
    cachedStorages = j.storages || [];
    renderStoragesTable();
    fillMountSelects();
}

function fillMountSelects() {
    for (const id of ['tm-backup-mount', 'tm-snap-mount']) {
        const sel = document.getElementById(id);
        if (!sel) continue;
        sel.innerHTML = cachedStorages
            .map((s) => `<option value="${escapeHtml(s.id)}">${escapeHtml(s.id)}</option>`)
            .join('');
    }
}

function renderStoragesTable() {
    const tbody = document.getElementById('tm-storages-tbody');
    if (!tbody) return;
    tbody.innerHTML = cachedStorages
        .map((s) => {
            const status = s.exists && s.writable ? 'OK' : escapeHtml(s.error || '不可');
            return `<tr data-mount-id="${escapeHtml(s.id)}">
                <td><code>${escapeHtml(s.id)}</code></td>
                <td><code>${escapeHtml(s.path)}</code></td>
                <td>${status}</td>
                <td>
                    <select class="tm-select tm-role" data-field="role">
                        <option value="off" ${s.role === 'off' ? 'selected' : ''}>off</option>
                        <option value="hourly" ${s.role === 'hourly' ? 'selected' : ''}>hourly</option>
                        <option value="daily" ${s.role === 'daily' ? 'selected' : ''}>daily</option>
                        <option value="both" ${s.role === 'both' ? 'selected' : ''}>both</option>
                    </select>
                </td>
                <td><input type="number" class="tm-input tm-hourly-ret" value="${s.hourlyRetention}" min="1" max="365" style="width:4rem"></td>
                <td><input type="number" class="tm-input tm-daily-ret" value="${s.dailyRetention}" min="1" max="365" style="width:4rem"></td>
                <td><input type="number" class="tm-input tm-daily-hour" value="${s.dailyHour}" min="0" max="23" style="width:3rem"></td>
                <td><input type="checkbox" class="tm-enabled" ${s.enabled ? 'checked' : ''}></td>
                <td><button type="button" class="btn btn-secondary btn-sm tm-save-storage">保存</button></td>
            </tr>`;
        })
        .join('');
}

async function saveStorageRow(row) {
    const mountId = row.dataset.mountId;
    if (!mountId) return;
    const role = row.querySelector('.tm-role')?.value;
    const hourlyRetention = parseInt(row.querySelector('.tm-hourly-ret')?.value || '48', 10);
    const dailyRetention = parseInt(row.querySelector('.tm-daily-ret')?.value || '14', 10);
    const dailyHour = parseInt(row.querySelector('.tm-daily-hour')?.value || '3', 10);
    const enabled = row.querySelector('.tm-enabled')?.checked ?? true;
    await apiFetch(`${API}/storages`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mountId, role, hourlyRetention, dailyRetention, dailyHour, enabled }),
    });
    setStatus(`${mountId} の設定を保存しました`);
    await loadStorages();
}

async function loadSnapshots() {
    const mountId = document.getElementById('tm-snap-mount')?.value || '';
    const kind = document.getElementById('tm-snap-kind')?.value || '';
    const qs = new URLSearchParams();
    if (mountId) qs.set('mountId', mountId);
    if (kind) qs.set('kind', kind);
    const j = await apiFetch(`${API}/snapshots?${qs}`);
    const tbody = document.getElementById('tm-snapshots-tbody');
    if (!tbody) return;
    const snaps = j.snapshots || [];
    tbody.innerHTML = snaps
        .map(
            (snap) => `<tr>
                <td><code>${escapeHtml(snap.snapshotId)}</code></td>
                <td>${escapeHtml(snap.kind)}</td>
                <td>${escapeHtml(snap.createdAt || '-')}</td>
                <td>${formatBytes(snap.bytes)}</td>
                <td>
                    <button type="button" class="btn btn-danger btn-sm tm-rollback-btn"
                        data-mount-id="${escapeHtml(snap.mountId)}"
                        data-snapshot-id="${escapeHtml(snap.snapshotId)}"
                        data-kind="${escapeHtml(snap.kind)}"
                        data-snapshot-dir="${escapeHtml(snap.snapshotDir)}">ロールバック</button>
                </td>
            </tr>`,
        )
        .join('');
}

async function loadRuns() {
    const j = await apiFetch(`${API}/status`);
    const tbody = document.getElementById('tm-runs-tbody');
    if (!tbody) return;
    const runs = j.recentRuns || [];
    tbody.innerHTML = runs
        .map((r) => {
            const t = r.startedAt ? new Date(r.startedAt).toLocaleString() : '-';
            return `<tr>
                <td>${escapeHtml(t)}</td>
                <td>${escapeHtml(r.kind)}</td>
                <td>${escapeHtml(r.scope)}</td>
                <td>${escapeHtml(r.mountId)}</td>
                <td>${escapeHtml(r.status)}${r.error ? ` <span class="error">${escapeHtml(r.error)}</span>` : ''}</td>
                <td>${formatBytes(r.bytes)}</td>
            </tr>`;
        })
        .join('');
}

/**
 * @param {object} snap
 */
function showRollbackPinModal(snap) {
    const existing = document.getElementById('tm-pin-modal');
    if (existing) existing.remove();

    const modal = document.createElement('div');
    modal.id = 'tm-pin-modal';
    modal.className = 'tm-pin-modal';
    modal.innerHTML = `
        <div class="tm-pin-dialog">
            <h3>ロールバック確認</h3>
            <p class="hint">${escapeHtml(snap.snapshotId)} (${escapeHtml(snap.kind)}) を復元します。サーバーは再起動されます。</p>
            <label>ロールバック PIN
                <input type="password" id="tm-rollback-pin" class="tm-input" autocomplete="off" style="display:block;width:100%;margin-top:0.25rem">
            </label>
            <div style="margin-top:1rem;display:flex;gap:0.5rem">
                <button type="button" class="btn btn-danger" id="tm-rollback-confirm">実行</button>
                <button type="button" class="btn btn-secondary" id="tm-rollback-cancel">キャンセル</button>
            </div>
            <p id="tm-rollback-modal-status" class="status-text" style="margin-top:0.5rem"></p>
        </div>
    `;
    document.body.appendChild(modal);

    modal.querySelector('#tm-rollback-cancel')?.addEventListener('click', () => modal.remove());
    modal.querySelector('#tm-rollback-confirm')?.addEventListener('click', async () => {
        const pin = /** @type {HTMLInputElement} */ (document.getElementById('tm-rollback-pin'))?.value || '';
        const st = document.getElementById('tm-rollback-modal-status');
        try {
            const j = await apiFetch(`${API}/rollback`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    pin,
                    mountId: snap.mountId,
                    snapshotId: snap.snapshotId,
                    kind: snap.kind,
                    snapshotDir: snap.snapshotDir,
                }),
            });
            if (st) st.textContent = j.message || 'ロールバックを開始しました';
            setTimeout(() => modal.remove(), 2000);
        } catch (e) {
            if (st) {
                st.textContent = e instanceof Error ? e.message : String(e);
                st.classList.add('error');
            }
        }
    });
}

function bindEvents() {
    document.getElementById('tm-storages-tbody')?.addEventListener('click', (e) => {
        const btn = /** @type {HTMLElement} */ (e.target)?.closest('.tm-save-storage');
        if (!btn) return;
        const row = btn.closest('tr');
        if (row) saveStorageRow(row).catch((err) => setStatus(err.message, true));
    });

    document.getElementById('tm-backup-run-btn')?.addEventListener('click', async () => {
        const scope = document.getElementById('tm-backup-scope')?.value || 'state';
        const mountId = document.getElementById('tm-backup-mount')?.value || '';
        setStatus('バックアップ実行中…');
        try {
            const j = await apiFetch(`${API}/backup/run`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ scope, mountId }),
            });
            setStatus(`バックアップ完了: ${j.snapshotDir || j.runId}`);
            await loadSnapshots();
            await loadRuns();
        } catch (e) {
            setStatus(e instanceof Error ? e.message : String(e), true);
        }
    });

    document.getElementById('tm-snap-refresh-btn')?.addEventListener('click', () => {
        loadSnapshots().catch((e) => setStatus(e.message, true));
    });

    document.getElementById('tm-snapshots-tbody')?.addEventListener('click', (e) => {
        const btn = /** @type {HTMLElement} */ (e.target)?.closest('.tm-rollback-btn');
        if (!btn) return;
        showRollbackPinModal({
            mountId: btn.dataset.mountId,
            snapshotId: btn.dataset.snapshotId,
            kind: btn.dataset.kind,
            snapshotDir: btn.dataset.snapshotDir,
        });
    });

    document.getElementById('tm-cf-invalidate-btn')?.addEventListener('click', async () => {
        if (!confirm('CloudFront の models/plane/avatars/env キャッシュを無効化しますか？')) return;
        setStatus('CF invalidation 実行中…');
        try {
            const j = await apiFetch(`${API}/cloudfront/invalidate`, { method: 'POST' });
            if (j.skipped) setStatus('S3 モード無効のためスキップしました');
            else setStatus(`無効化リクエスト送信: ${(j.prefixes || []).join(', ')}`);
        } catch (e) {
            setStatus(e instanceof Error ? e.message : String(e), true);
        }
    });
}

async function refreshAll() {
    try {
        await loadStorages();
        await loadSnapshots();
        await loadRuns();
        setStatus('');
    } catch (e) {
        setStatus(e instanceof Error ? e.message : String(e), true);
    }
}

function init() {
    ensurePanelDom();
    refreshAll();

    const navBtn = document.querySelector(`[data-panel="${NAV_DATA_PANEL}"]`);
    navBtn?.addEventListener('click', () => refreshAll());
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
