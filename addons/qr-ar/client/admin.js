// addons/qr-ar/client/admin.js — QR-AR カード管理パネル
import { adminFetch } from '/js/admin-api-fetch.js';

const PANEL_ID = 'panel-addon-qr-ar';
const NAV_DATA_PANEL = 'panel-addon-qr-ar';
const API_BASE = '/admin/addons/qr-ar/cards';

/** @type {object[]} */
let cards = [];
/** @type {number|null} */
let editingId = null;

/**
 * @param {string} path
 * @param {RequestInit} [init]
 */
async function apiFetch(path, init) {
    const r = await adminFetch(path, { credentials: 'include', ...init });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
        if (r.status === 404 && path.startsWith(API_BASE)) {
            throw new Error(
                'QR-AR API が見つかりません。管理画面「アドオン」で qr-ar が有効かつ読込済みか確認し、未読込なら Node を再起動してください。'
            );
        }
        throw new Error(j.error || `HTTP ${r.status}`);
    }
    return j;
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
    btn.innerHTML =
        '<i class="bi bi-qr-code-scan" aria-hidden="true"></i><span>QR-AR</span>';
    const addonsBtn = nav.querySelector('[data-panel="panel-addons"]');
    if (addonsBtn) nav.insertBefore(btn, addonsBtn);
    else nav.appendChild(btn);

    const panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.className = 'admin-panel';
    panel.innerHTML = `
        <section class="qr-ar-admin-section">
            <header class="qr-ar-admin-header">
                <h2>QR-AR カード</h2>
                <p class="hint qr-ar-admin-lead">
                    カード ID を QR に印刷（生 ID のみ）。ユーザーは <a href="/qr-ar/" target="_blank" rel="noopener">/qr-ar/</a> でカメラを起動し、QR を映して 3D を表示します。
                </p>
            </header>
            <p id="qr-ar-admin-status" class="status-text" role="status"></p>

            <div class="qr-ar-admin-layout">
                <div class="qr-ar-admin-form-card">
                    <h3 class="qr-ar-admin-card-title" id="qr-ar-form-title">新規カード</h3>
                    <form id="qr-ar-card-form" class="qr-ar-admin-form">
                        <label class="qr-ar-admin-label">
                            カード ID（QR の中身）
                            <input type="text" id="qr-ar-card-id" class="qr-ar-admin-input" pattern="[A-Za-z0-9_-]{1,64}" required placeholder="001" />
                        </label>
                        <label class="qr-ar-admin-label">
                            表示名
                            <input type="text" id="qr-ar-label" class="qr-ar-admin-input" maxlength="128" required />
                        </label>
                        <label class="qr-ar-admin-label">
                            モデルスケール
                            <input type="number" id="qr-ar-model-scale" class="qr-ar-admin-input" step="0.01" value="1" />
                        </label>
                        <div class="qr-ar-admin-coords">
                            <label>Offset X (m)<input type="number" id="qr-ar-offset-x" step="0.01" value="0" /></label>
                            <label>Offset Y (m)<input type="number" id="qr-ar-offset-y" step="0.01" value="0.05" /></label>
                            <label>Offset Z (m)<input type="number" id="qr-ar-offset-z" step="0.01" value="0" /></label>
                        </div>
                        <label class="qr-ar-admin-label">
                            QR 物理サイズ (mm)
                            <input type="number" id="qr-ar-qr-size-mm" class="qr-ar-admin-input" min="5" max="200" step="1" value="20" />
                        </label>
                        <label class="qr-ar-admin-check">
                            <input type="checkbox" id="qr-ar-enabled" checked />
                            有効
                        </label>
                        <div class="qr-ar-admin-form-actions">
                            <button type="submit" class="btn btn-primary">保存</button>
                            <button type="button" id="qr-ar-cancel-edit" class="btn btn-secondary" hidden>キャンセル</button>
                        </div>
                    </form>
                    <div id="qr-ar-model-upload-wrap" class="qr-ar-model-upload" hidden>
                        <h4>GLB アップロード</h4>
                        <input type="file" id="qr-ar-model-file" accept=".glb,model/gltf-binary" />
                        <button type="button" id="qr-ar-model-upload-btn" class="btn btn-sm">アップロード</button>
                    </div>
                    <div id="qr-ar-qr-preview-wrap" class="qr-ar-qr-preview" hidden>
                        <h4>印刷用 QR（カード ID）</h4>
                        <img id="qr-ar-qr-preview-img" alt="QR preview" width="200" height="200" />
                    </div>
                </div>

                <div class="qr-ar-admin-table-wrap">
                    <h3 class="qr-ar-admin-card-title">登録済みカード <span id="qr-ar-list-count" class="qr-ar-list-count"></span></h3>
                    <div class="qr-ar-admin-table-scroll">
                        <table class="qr-ar-admin-table" id="qr-ar-cards-table">
                            <thead>
                                <tr>
                                    <th>ID</th>
                                    <th>カード ID</th>
                                    <th>名前</th>
                                    <th>モデル</th>
                                    <th>有効</th>
                                    <th>操作</th>
                                </tr>
                            </thead>
                            <tbody id="qr-ar-cards-tbody"></tbody>
                        </table>
                    </div>
                </div>
            </div>
        </section>
    `;
    panels.appendChild(panel);
    injectStyles();
    bindEvents();
}

function injectStyles() {
    if (document.getElementById('qr-ar-admin-styles')) return;
    const style = document.createElement('style');
    style.id = 'qr-ar-admin-styles';
    style.textContent = `
        .qr-ar-admin-section { max-width: 1200px; }
        .qr-ar-admin-header h2 { margin: 0 0 0.35rem; }
        .qr-ar-admin-lead { margin: 0; font-size: 0.92rem; line-height: 1.55; }
        .qr-ar-admin-layout { display: grid; grid-template-columns: minmax(280px, 1fr) minmax(320px, 1.2fr); gap: 1rem; align-items: start; }
        @media (max-width: 900px) { .qr-ar-admin-layout { grid-template-columns: 1fr; } }
        .qr-ar-admin-form-card, .qr-ar-admin-table-wrap {
            padding: 1rem; border: 1px solid var(--admin-border, #ddd); border-radius: 8px; background: #fff;
        }
        .qr-ar-admin-card-title { margin: 0 0 0.75rem; font-size: 1.05rem; }
        .qr-ar-admin-form { display: flex; flex-direction: column; gap: 0.65rem; }
        .qr-ar-admin-label { display: flex; flex-direction: column; gap: 0.25rem; font-size: 0.9rem; }
        .qr-ar-admin-input { padding: 0.4rem 0.5rem; border: 1px solid #ccc; border-radius: 4px; }
        .qr-ar-admin-coords { display: grid; grid-template-columns: repeat(3, 1fr); gap: 0.5rem; font-size: 0.85rem; }
        .qr-ar-admin-coords label { display: flex; flex-direction: column; gap: 0.2rem; }
        .qr-ar-admin-check { display: flex; align-items: center; gap: 0.5rem; font-size: 0.9rem; }
        .qr-ar-admin-form-actions { display: flex; gap: 0.5rem; flex-wrap: wrap; }
        .qr-ar-model-upload, .qr-ar-qr-preview { margin-top: 1rem; padding-top: 0.75rem; border-top: 1px solid #eee; }
        .qr-ar-qr-preview img { display: block; margin-top: 0.5rem; background: #fff; padding: 0.5rem; border: 1px solid #ddd; }
        .qr-ar-admin-table-scroll { max-height: 420px; overflow: auto; border: 1px solid #eee; border-radius: 4px; }
        .qr-ar-admin-table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
        .qr-ar-admin-table th { position: sticky; top: 0; background: #f5f5f5; padding: 0.45rem 0.5rem; text-align: left; }
        .qr-ar-admin-table td { border-bottom: 1px solid #eee; padding: 0.4rem 0.5rem; vertical-align: middle; }
        .qr-ar-row-selected { background: rgba(21, 101, 192, 0.08); }
        .qr-ar-list-count { font-weight: normal; color: #888; font-size: 0.9em; }
        body.admin-dark .qr-ar-admin-form-card, body.admin-dark .qr-ar-admin-table-wrap { background: rgba(255,255,255,0.03); }
        body.admin-dark .qr-ar-admin-table th { background: rgba(255,255,255,0.06); }
    `;
    document.head.appendChild(style);
}

/**
 * @param {string} msg
 * @param {boolean} [err]
 */
function setAdminStatus(msg, err = false) {
    const el = document.getElementById('qr-ar-admin-status');
    if (!el) return;
    el.textContent = msg;
    el.classList.toggle('error', err);
}

function getFormValues() {
    const mm = Number(document.getElementById('qr-ar-qr-size-mm').value);
    return {
        cardId: document.getElementById('qr-ar-card-id').value.trim(),
        label: document.getElementById('qr-ar-label').value.trim(),
        modelScale: Number(document.getElementById('qr-ar-model-scale').value),
        offsetX: Number(document.getElementById('qr-ar-offset-x').value),
        offsetY: Number(document.getElementById('qr-ar-offset-y').value),
        offsetZ: Number(document.getElementById('qr-ar-offset-z').value),
        qrPhysicalSizeM: mm > 0 ? mm / 1000 : 0.02,
        enabled: document.getElementById('qr-ar-enabled').checked,
    };
}

function resetForm() {
    editingId = null;
    document.getElementById('qr-ar-form-title').textContent = '新規カード';
    document.getElementById('qr-ar-card-id').disabled = false;
    document.getElementById('qr-ar-card-form').reset();
    document.getElementById('qr-ar-offset-y').value = '0.05';
    document.getElementById('qr-ar-qr-size-mm').value = '20';
    document.getElementById('qr-ar-enabled').checked = true;
    document.getElementById('qr-ar-cancel-edit').hidden = true;
    document.getElementById('qr-ar-model-upload-wrap').hidden = true;
    document.getElementById('qr-ar-qr-preview-wrap').hidden = true;
}

/**
 * @param {object} card
 */
function fillForm(card) {
    editingId = card.id;
    document.getElementById('qr-ar-form-title').textContent = `編集: ${card.cardId}`;
    document.getElementById('qr-ar-card-id').value = card.cardId;
    document.getElementById('qr-ar-card-id').disabled = true;
    document.getElementById('qr-ar-label').value = card.label;
    document.getElementById('qr-ar-model-scale').value = String(card.modelScale ?? 1);
    document.getElementById('qr-ar-offset-x').value = String(card.offset?.x ?? 0);
    document.getElementById('qr-ar-offset-y').value = String(card.offset?.y ?? 0.05);
    document.getElementById('qr-ar-offset-z').value = String(card.offset?.z ?? 0);
    document.getElementById('qr-ar-qr-size-mm').value = String(Math.round((card.qrPhysicalSizeM || 0.02) * 1000));
    document.getElementById('qr-ar-enabled').checked = card.enabled;
    document.getElementById('qr-ar-cancel-edit').hidden = false;
    document.getElementById('qr-ar-model-upload-wrap').hidden = false;
    document.getElementById('qr-ar-qr-preview-wrap').hidden = false;
    const img = document.getElementById('qr-ar-qr-preview-img');
    if (img) {
        img.src = `${API_BASE}/${card.id}/qr-preview?t=${Date.now()}`;
    }
}

function renderTable() {
    const tbody = document.getElementById('qr-ar-cards-tbody');
    const countEl = document.getElementById('qr-ar-list-count');
    if (!tbody) return;
    countEl.textContent = cards.length ? `(${cards.length})` : '';
    if (!cards.length) {
        tbody.innerHTML = `<tr><td colspan="6" class="qr-ar-empty">カードがありません</td></tr>`;
        return;
    }
    tbody.innerHTML = cards
        .map((c) => {
            const sel = editingId === c.id ? 'qr-ar-row-selected' : '';
            return `<tr class="${sel}">
                <td>${c.id}</td>
                <td><code>${escapeHtml(c.cardId)}</code></td>
                <td>${escapeHtml(c.label)}</td>
                <td>${c.hasModel ? 'あり' : '—'}</td>
                <td>${c.enabled ? '有効' : '無効'}</td>
                <td>
                    <button type="button" class="btn btn-sm qr-ar-edit-btn" data-id="${c.id}">編集</button>
                    <button type="button" class="btn btn-sm btn-danger qr-ar-del-btn" data-id="${c.id}">削除</button>
                </td>
            </tr>`;
        })
        .join('');
}

async function loadCards() {
    const j = await apiFetch(API_BASE);
    cards = j.cards || [];
    renderTable();
}

function bindEvents() {
    document.getElementById('qr-ar-card-form')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const body = getFormValues();
        try {
            if (editingId) {
                await apiFetch(`${API_BASE}/${editingId}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body),
                });
                setAdminStatus('更新しました');
            } else {
                const j = await apiFetch(API_BASE, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body),
                });
                fillForm(j.card);
                setAdminStatus('作成しました — GLB をアップロードしてください');
            }
            await loadCards();
        } catch (err) {
            setAdminStatus(err.message || '保存に失敗しました', true);
        }
    });

    document.getElementById('qr-ar-cancel-edit')?.addEventListener('click', () => {
        resetForm();
        renderTable();
    });

    document.getElementById('qr-ar-cards-tbody')?.addEventListener('click', async (e) => {
        const editBtn = e.target.closest('.qr-ar-edit-btn');
        const delBtn = e.target.closest('.qr-ar-del-btn');
        if (editBtn) {
            const id = Number(editBtn.dataset.id);
            const card = cards.find((c) => c.id === id);
            if (card) fillForm(card);
            renderTable();
            return;
        }
        if (delBtn) {
            const id = Number(delBtn.dataset.id);
            const card = cards.find((c) => c.id === id);
            if (!card) return;
            if (!confirm(`カード「${card.cardId}」を削除しますか？`)) return;
            try {
                await apiFetch(`${API_BASE}/${id}`, { method: 'DELETE' });
                if (editingId === id) resetForm();
                setAdminStatus('削除しました');
                await loadCards();
            } catch (err) {
                setAdminStatus(err.message || '削除に失敗しました', true);
            }
        }
    });

    document.getElementById('qr-ar-model-upload-btn')?.addEventListener('click', async () => {
        if (!editingId) return;
        const input = document.getElementById('qr-ar-model-file');
        const file = input?.files?.[0];
        if (!file) {
            setAdminStatus('GLB ファイルを選択してください', true);
            return;
        }
        const fd = new FormData();
        fd.append('model', file);
        try {
            await apiFetch(`${API_BASE}/${editingId}/model`, { method: 'POST', body: fd });
            setAdminStatus('モデルをアップロードしました');
            input.value = '';
            await loadCards();
            const card = cards.find((c) => c.id === editingId);
            if (card) fillForm(card);
        } catch (err) {
            setAdminStatus(err.message || 'アップロードに失敗しました', true);
        }
    });
}

async function initQrArAdmin() {
    ensurePanelDom();
    try {
        await loadCards();
        setAdminStatus('準備完了');
    } catch (e) {
        setAdminStatus(e.message || '読み込みに失敗しました', true);
    }
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initQrArAdmin);
} else {
    initQrArAdmin();
}
