// addons/nfc-spawn/client/admin.js — 管理画面に NFCタグパネルを動的追加
const PANEL_ID = 'panel-addon-nfc-spawn';
const NAV_DATA_PANEL = 'panel-addon-nfc-spawn';
const API_BASE = '/admin/addons/nfc-spawn/spawns';

/** @type {string[]} */
let worldIds = [];

/** @type {object[]} */
let spawns = [];

/** @type {number|null} */
let editingId = null;

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
 * @param {string} text
 */
async function copyText(text) {
    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.left = '-9999px';
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        document.body.removeChild(ta);
        return ok;
    }
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
    btn.innerHTML = '<i class="bi bi-nfc"></i> NFCタグ';
    const addonsBtn = nav.querySelector('[data-panel="panel-addons"]');
    if (addonsBtn) {
        nav.insertBefore(btn, addonsBtn);
    } else {
        nav.appendChild(btn);
    }

    const panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.className = 'admin-panel';
    panel.innerHTML = `
        <section class="nfc-spawn-section">
            <h2>NFCタグ・スポーン地点</h2>
            <p class="hint">各タグに割り当てた不透明トークンで <code>/?spawn=TOKEN</code> から入場します。座標は URL に含めません。アドオン有効化後は Node 再起動が必要です。</p>
            <p id="nfc-spawn-status" class="status-text" role="status"></p>

            <div class="nfc-spawn-layout">
                <div class="nfc-spawn-form-wrap">
                    <h3 id="nfc-spawn-form-title">新規タグ</h3>
                    <form id="nfc-spawn-form" class="nfc-spawn-form">
                        <input type="hidden" id="nfc-spawn-edit-id" value="">
                        <label class="nfc-spawn-label">ラベル
                            <input type="text" id="nfc-spawn-label" required maxlength="128" placeholder="図書館模型">
                        </label>
                        <label class="nfc-spawn-label">ワールド
                            <select id="nfc-spawn-world" required></select>
                        </label>
                        <div class="nfc-spawn-coords">
                            <label>X <input type="number" id="nfc-spawn-x" step="any" value="0"></label>
                            <label>Y <input type="number" id="nfc-spawn-y" step="any" value="10"></label>
                            <label>Z <input type="number" id="nfc-spawn-z" step="any" value="0"></label>
                            <label>Yaw° <input type="number" id="nfc-spawn-yaw" step="any" value="0"></label>
                        </div>
                        <label class="nfc-spawn-label">NFC UID（任意・メモ）
                            <input type="text" id="nfc-spawn-uid" maxlength="64" placeholder="04:AB:...">
                        </label>
                        <label class="nfc-spawn-check">
                            <input type="checkbox" id="nfc-spawn-enabled" checked> 有効
                        </label>
                        <div class="nfc-spawn-form-actions">
                            <button type="submit" class="btn btn-primary" id="nfc-spawn-save-btn">保存</button>
                            <button type="button" class="btn btn-secondary" id="nfc-spawn-cancel-btn" hidden>キャンセル</button>
                        </div>
                    </form>
                </div>

                <div class="nfc-spawn-table-wrap">
                    <h3>登録一覧</h3>
                    <div class="table-responsive">
                        <table class="nfc-spawn-table">
                            <thead>
                                <tr>
                                    <th>ラベル</th>
                                    <th>ワールド</th>
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
        </section>
    `;
    panels.appendChild(panel);

    btn.addEventListener('click', () => showNfcSpawnPanel());
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

/**
 * ワールド select を更新
 */
function populateWorldSelect() {
    const sel = document.getElementById('nfc-spawn-world');
    if (!sel) return;
    sel.innerHTML = worldIds
        .map((id) => `<option value="${escapeHtml(id)}">${escapeHtml(id)}</option>`)
        .join('');
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
 * フォームをリセット
 */
function resetForm() {
    editingId = null;
    const title = document.getElementById('nfc-spawn-form-title');
    const cancel = document.getElementById('nfc-spawn-cancel-btn');
    const editId = document.getElementById('nfc-spawn-edit-id');
    if (title) title.textContent = '新規タグ';
    if (cancel) cancel.hidden = true;
    if (editId) editId.value = '';
    const form = document.getElementById('nfc-spawn-form');
    if (form) form.reset();
    const enabled = document.getElementById('nfc-spawn-enabled');
    if (enabled) enabled.checked = true;
    const y = document.getElementById('nfc-spawn-y');
    if (y) y.value = '10';
}

/**
 * @param {object} row
 */
function fillForm(row) {
    editingId = row.id;
    const title = document.getElementById('nfc-spawn-form-title');
    const cancel = document.getElementById('nfc-spawn-cancel-btn');
    const editId = document.getElementById('nfc-spawn-edit-id');
    if (title) title.textContent = `編集: ${row.label}`;
    if (cancel) cancel.hidden = false;
    if (editId) editId.value = String(row.id);
    const set = (id, val) => {
        const el = document.getElementById(id);
        if (el) el.value = val;
    };
    set('nfc-spawn-label', row.label);
    set('nfc-spawn-world', row.world_id);
    set('nfc-spawn-x', row.x);
    set('nfc-spawn-y', row.y);
    set('nfc-spawn-z', row.z);
    set('nfc-spawn-yaw', row.yaw ?? 0);
    set('nfc-spawn-uid', row.nfc_tag_uid || '');
    const enabled = document.getElementById('nfc-spawn-enabled');
    if (enabled) enabled.checked = row.enabled !== false;
}

/**
 * フォームから body を読む
 */
function readFormBody() {
    const label = /** @type {HTMLInputElement} */ (document.getElementById('nfc-spawn-label'))?.value?.trim();
    const world_id = /** @type {HTMLSelectElement} */ (document.getElementById('nfc-spawn-world'))?.value;
    const x = parseFloat(/** @type {HTMLInputElement} */ (document.getElementById('nfc-spawn-x'))?.value);
    const y = parseFloat(/** @type {HTMLInputElement} */ (document.getElementById('nfc-spawn-y'))?.value);
    const z = parseFloat(/** @type {HTMLInputElement} */ (document.getElementById('nfc-spawn-z'))?.value);
    const yaw = parseFloat(/** @type {HTMLInputElement} */ (document.getElementById('nfc-spawn-yaw'))?.value);
    const uidRaw = /** @type {HTMLInputElement} */ (document.getElementById('nfc-spawn-uid'))?.value?.trim();
    const enabled = /** @type {HTMLInputElement} */ (document.getElementById('nfc-spawn-enabled'))?.checked;
    return {
        label,
        world_id,
        x,
        y,
        z,
        yaw: Number.isFinite(yaw) ? yaw : 0,
        nfc_tag_uid: uidRaw || null,
        enabled: enabled !== false,
    };
}

/**
 * 一覧テーブルを描画
 */
function renderTable() {
    const tbody = document.getElementById('nfc-spawn-tbody');
    if (!tbody) return;
    if (!spawns.length) {
        tbody.innerHTML = '<tr><td colspan="5" class="nfc-spawn-empty">登録なし</td></tr>';
        return;
    }
    tbody.innerHTML = spawns
        .map((row) => {
            const coord = `${row.x}, ${row.y}, ${row.z}`;
            const enabledMark = row.enabled ? '有効' : '無効';
            return `<tr data-id="${row.id}">
                <td>${escapeHtml(row.label)}</td>
                <td><code>${escapeHtml(row.world_id)}</code></td>
                <td><code>${escapeHtml(coord)}</code></td>
                <td>${enabledMark}</td>
                <td class="nfc-spawn-actions">
                    <button type="button" class="btn btn-secondary btn-sm nfc-copy-url" data-url="${escapeHtml(row.spawnUrl || '')}">URL</button>
                    <button type="button" class="btn btn-secondary btn-sm nfc-edit">編集</button>
                    <button type="button" class="btn btn-secondary btn-sm nfc-regen">再発行</button>
                    <button type="button" class="btn btn-secondary btn-sm nfc-delete">削除</button>
                </td>
            </tr>`;
        })
        .join('');

    tbody.querySelectorAll('.nfc-copy-url').forEach((btn) => {
        btn.addEventListener('click', async () => {
            const url = btn.getAttribute('data-url') || '';
            if (!url) return;
            const ok = await copyText(url);
            setStatus(ok ? 'URL をコピーしました' : 'コピーに失敗しました', !ok);
        });
    });
    tbody.querySelectorAll('.nfc-edit').forEach((btn) => {
        btn.addEventListener('click', () => {
            const tr = btn.closest('tr');
            const id = Number(tr?.getAttribute('data-id'));
            const row = spawns.find((s) => s.id === id);
            if (row) fillForm(row);
        });
    });
    tbody.querySelectorAll('.nfc-regen').forEach((btn) => {
        btn.addEventListener('click', async () => {
            const tr = btn.closest('tr');
            const id = Number(tr?.getAttribute('data-id'));
            if (!id || !window.confirm('トークンを再発行しますか？旧 URL は使えなくなります。')) return;
            try {
                await apiFetch(`${API_BASE}/${id}/regenerate-token`, { method: 'POST' });
                setStatus('トークンを再発行しました');
                await refreshNfcSpawnPanel();
            } catch (e) {
                setStatus(e instanceof Error ? e.message : '再発行に失敗', true);
            }
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

/**
 * データ読み込み
 */
async function refreshNfcSpawnPanel() {
    try {
        const worldsRes = await apiFetch('/admin/worlds');
        worldIds = Object.keys(worldsRes || {}).sort();
        populateWorldSelect();

        const j = await apiFetch(API_BASE);
        spawns = j.spawns || [];
        renderTable();
    } catch (e) {
        setStatus(e instanceof Error ? e.message : '読み込みに失敗', true);
    }
}

/**
 * フォーム送信
 */
function bindForm() {
    const form = document.getElementById('nfc-spawn-form');
    const cancel = document.getElementById('nfc-spawn-cancel-btn');
    if (!form) return;

    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const body = readFormBody();
        if (!body.label) {
            setStatus('ラベルを入力してください', true);
            return;
        }
        try {
            if (editingId != null) {
                await apiFetch(`${API_BASE}/${editingId}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body),
                });
                setStatus('更新しました');
            } else {
                await apiFetch(API_BASE, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body),
                });
                setStatus('作成しました');
            }
            resetForm();
            await refreshNfcSpawnPanel();
        } catch (err) {
            setStatus(err instanceof Error ? err.message : '保存に失敗', true);
        }
    });

    cancel?.addEventListener('click', () => {
        resetForm();
        setStatus('');
    });
}

/**
 * 管理 UI 初期化
 */
function initNfcSpawnAdmin() {
    ensurePanelDom();
    bindForm();
    injectAdminStyles();
}

/**
 * 最小限のレイアウト用スタイル
 */
function injectAdminStyles() {
    if (document.getElementById('nfc-spawn-admin-styles')) return;
    const style = document.createElement('style');
    style.id = 'nfc-spawn-admin-styles';
    style.textContent = `
        .nfc-spawn-layout { display: grid; grid-template-columns: minmax(260px, 360px) 1fr; gap: 1.5rem; align-items: start; }
        @media (max-width: 900px) { .nfc-spawn-layout { grid-template-columns: 1fr; } }
        .nfc-spawn-form { display: flex; flex-direction: column; gap: 0.75rem; }
        .nfc-spawn-label { display: flex; flex-direction: column; gap: 0.25rem; font-size: 0.9rem; }
        .nfc-spawn-label input, .nfc-spawn-label select { width: 100%; }
        .nfc-spawn-coords { display: grid; grid-template-columns: repeat(2, 1fr); gap: 0.5rem; }
        .nfc-spawn-coords label { display: flex; flex-direction: column; gap: 0.2rem; font-size: 0.85rem; }
        .nfc-spawn-check { display: flex; align-items: center; gap: 0.5rem; }
        .nfc-spawn-form-actions { display: flex; gap: 0.5rem; flex-wrap: wrap; }
        .nfc-spawn-table { width: 100%; border-collapse: collapse; font-size: 0.9rem; }
        .nfc-spawn-table th, .nfc-spawn-table td { border: 1px solid var(--admin-border, #444); padding: 0.4rem 0.5rem; text-align: left; }
        .nfc-spawn-actions { display: flex; flex-wrap: wrap; gap: 0.25rem; }
        .nfc-spawn-empty { text-align: center; color: #888; }
        .btn-sm { padding: 0.2rem 0.5rem; font-size: 0.8rem; }
    `;
    document.head.appendChild(style);
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initNfcSpawnAdmin);
} else {
    initNfcSpawnAdmin();
}
