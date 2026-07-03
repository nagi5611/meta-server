// addons/meta-bench-r1/client/admin.js — ベンチマーク管理パネル
const PANEL_ID = 'panel-addon-meta-bench-r1';
const NAV_DATA_PANEL = 'panel-addon-meta-bench-r1';
const API = '/admin/addons/meta-bench-r1';

/** @type {ReturnType<typeof setInterval> | null} */
let pollTimer = null;

/**
 * @param {string} path
 * @param {RequestInit} [init]
 */
async function apiFetch(path, init) {
    const r = await fetch(path, { credentials: 'include', ...init });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
        const err = new Error(j.error || j.failures?.join?.('\n') || `HTTP ${r.status}`);
        /** @type {any} */ (err).failures = j.failures;
        throw err;
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
    btn.innerHTML = '<i class="bi bi-speedometer2" aria-hidden="true"></i><span>ベンチR1</span>';
    const addonsBtn = nav.querySelector('[data-panel="panel-addons"]');
    if (addonsBtn) nav.insertBefore(btn, addonsBtn);
    else nav.appendChild(btn);

    const panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.className = 'admin-panel';
    panel.innerHTML = `
        <section class="bench-r1-section">
            <header class="bench-r1-header">
                <h2>meta-bench-r1 ベンチマーク</h2>
                <p class="hint bench-r1-lead">本番負荷テスト用 addon。他 addon が有効でも実行できます（スコアは追加負荷の影響を受ける場合があります）。</p>
            </header>

            <div class="bench-r1-p07 card-like">
                <h3>実行前の確認</h3>
                <ol>
                    <li>管理画面の <strong>アドオン</strong> で <code>meta-bench-r1</code> が有効であること</li>
                    <li>addon を有効/無効した直後は Node を再起動（<a href="/docs/addons-restart-policy.md" target="_blank" rel="noopener">再起動ポリシー</a>）</li>
                    <li>Bench Runner を起動し、下のプリフライトが合格してからベンチ開始</li>
                </ol>
            </div>

            <div class="bench-r1-grid">
                <div class="bench-r1-card card-like">
                    <h3>Bench Runner</h3>
                    <p id="bench-r1-runner-status" class="status-text">読み込み中…</p>
                    <button type="button" class="btn btn-secondary btn-sm" id="bench-r1-refresh-runner">Runner 状態を更新</button>
                    <button type="button" class="btn btn-secondary btn-sm" id="bench-r1-pairing-code">ペアリングコード発行</button>
                    <p id="bench-r1-pairing-display" class="hint"></p>
                </div>

                <div class="bench-r1-card card-like">
                    <h3>ベンチ実行</h3>
                    <label class="bench-r1-label">bot 数
                        <input type="number" id="bench-r1-bot-count" class="bench-r1-input" min="1" max="200" value="50" />
                    </label>
                    <div class="bench-r1-actions">
                        <button type="button" class="btn btn-secondary" id="bench-r1-preflight">プリフライト</button>
                        <button type="button" class="btn btn-primary" id="bench-r1-start">ベンチ開始</button>
                        <button type="button" class="btn btn-danger" id="bench-r1-abort" disabled>中止</button>
                    </div>
                    <p id="bench-r1-run-status" class="status-text" role="status"></p>
                    <ul id="bench-r1-failures" class="bench-r1-failures"></ul>
                    <p id="bench-r1-report-link" class="hint"></p>
                </div>
            </div>
        </section>
    `;
    panels.appendChild(panel);

    btn.addEventListener('click', () => {
        document.dispatchEvent(new CustomEvent('admin-panel-request', { detail: { panelId: NAV_DATA_PANEL } }));
    });

    injectStyles();
    bindEvents();
}

function injectStyles() {
    if (document.getElementById('bench-r1-admin-styles')) return;
    const style = document.createElement('style');
    style.id = 'bench-r1-admin-styles';
    style.textContent = `
        .bench-r1-section { max-width: 960px; }
        .bench-r1-header h2 { margin: 0 0 0.35rem; }
        .bench-r1-lead { margin: 0 0 1rem; line-height: 1.55; }
        .bench-r1-p07 { margin-bottom: 1rem; padding: 1rem; border: 1px solid #e0c080; border-radius: 8px; background: #fffbf0; }
        .bench-r1-p07 h3 { margin: 0 0 0.5rem; font-size: 1rem; color: #a60; }
        .bench-r1-p07 ol { margin: 0; padding-left: 1.25rem; }
        .bench-r1-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; }
        @media (max-width: 800px) { .bench-r1-grid { grid-template-columns: 1fr; } }
        .bench-r1-card.card-like { padding: 1rem; border: 1px solid var(--admin-border, #ddd); border-radius: 8px; background: #fff; }
        .bench-r1-card h3 { margin: 0 0 0.75rem; font-size: 1.05rem; }
        .bench-r1-label { display: flex; flex-direction: column; gap: 0.35rem; margin-bottom: 0.75rem; font-size: 0.9rem; }
        .bench-r1-input { max-width: 8rem; padding: 0.35rem 0.5rem; }
        .bench-r1-actions { display: flex; flex-wrap: wrap; gap: 0.5rem; margin-bottom: 0.5rem; }
        .bench-r1-failures { margin: 0.5rem 0 0; padding-left: 1.25rem; color: #c62828; font-size: 0.9rem; }
        .status-text.error { color: #c62828; }
        .status-text.success { color: #2e7d32; }
        body.admin-dark .bench-r1-card.card-like { background: rgba(255,255,255,0.03); }
        body.admin-dark .bench-r1-p07 { background: rgba(255, 200, 80, 0.08); }
    `;
    document.head.appendChild(style);
}

/**
 * @param {string} text
 * @param {boolean} [isError]
 */
function setRunStatus(text, isError = false) {
    const el = document.getElementById('bench-r1-run-status');
    if (!el) return;
    el.textContent = text;
    el.classList.toggle('error', isError);
    el.classList.toggle('success', !isError && text.length > 0);
}

/**
 * @param {string[]} failures
 */
function showFailures(failures) {
    const ul = document.getElementById('bench-r1-failures');
    if (!ul) return;
    if (!failures?.length) {
        ul.innerHTML = '';
        return;
    }
    ul.innerHTML = failures.map((f) => `<li>${escapeHtml(f)}</li>`).join('');
}

async function refreshRunnerStatus() {
    const el = document.getElementById('bench-r1-runner-status');
    if (!el) return;
    try {
        const j = await apiFetch(`${API}/runner/status`);
        const r = j.runner || {};
        if (!r.connected) {
            el.textContent = '未接続 — 手元 PC で runner/serve.js を起動してください。';
            el.className = 'status-text error';
            return;
        }
        el.textContent = `接続中: ${r.name || 'runner'} / 推奨 max bots: ${r.recommendedMaxBots ?? '-'}`;
        el.className = 'status-text success';
    } catch (e) {
        el.textContent = `取得失敗: ${e instanceof Error ? e.message : String(e)}`;
        el.className = 'status-text error';
    }
}

/** @type {string | null} */
let activeRunId = null;

async function refreshRunStatus() {
    if (!activeRunId) return;
    try {
        const j = await apiFetch(`${API}/runs/${activeRunId}`);
        const run = j.run;
        if (!run) return;
        setRunStatus(`run ${run.id}: ${run.status} / phase: ${run.phase}`, run.status === 'failed');
        const abortBtn = document.getElementById('bench-r1-abort');
        if (abortBtn) abortBtn.disabled = run.status !== 'running' && run.status !== 'preflight';

        if (run.reportFilename && (run.status === 'completed' || run.status === 'partial')) {
            const linkEl = document.getElementById('bench-r1-report-link');
            if (linkEl) {
                const url = `${API}/reports/${encodeURIComponent(run.reportFilename)}`;
                linkEl.innerHTML = `<a href="${escapeHtml(url)}" target="_blank" rel="noopener">レポートを開く</a>`;
            }
            stopPolling();
        }
        if (run.status === 'failed') stopPolling();
    } catch {
        /* ignore poll errors */
    }
}

function startPolling() {
    stopPolling();
    pollTimer = setInterval(() => void refreshRunStatus(), 3000);
}

function stopPolling() {
    if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
    }
}

function bindEvents() {
    document.getElementById('bench-r1-refresh-runner')?.addEventListener('click', () => void refreshRunnerStatus());
    document.getElementById('bench-r1-pairing-code')?.addEventListener('click', async () => {
        const disp = document.getElementById('bench-r1-pairing-display');
        try {
            const j = await apiFetch(`${API}/runner/pairing-code`);
            if (disp) {
                disp.textContent = `コード: ${j.code}（10 分有効）— runner に --pairing ${j.code} で登録`;
            }
        } catch (e) {
            if (disp) disp.textContent = `失敗: ${e instanceof Error ? e.message : String(e)}`;
        }
    });

    document.getElementById('bench-r1-preflight')?.addEventListener('click', async () => {
        const botCount = parseInt(String(document.getElementById('bench-r1-bot-count')?.value || '50'), 10);
        showFailures([]);
        try {
            const j = await apiFetch(`${API}/preflight?botCount=${botCount}`);
            if (j.ok) {
                setRunStatus('プリフライト合格', false);
                showFailures([]);
            } else {
                setRunStatus('プリフライト不合格', true);
                showFailures(j.failures || []);
            }
        } catch (e) {
            setRunStatus(`プリフライト失敗: ${e instanceof Error ? e.message : String(e)}`, true);
            showFailures(/** @type {any} */ (e).failures || []);
        }
    });

    document.getElementById('bench-r1-start')?.addEventListener('click', async () => {
        const botCount = parseInt(String(document.getElementById('bench-r1-bot-count')?.value || '50'), 10);
        showFailures([]);
        setRunStatus('開始中…');
        try {
            const j = await apiFetch(`${API}/runs`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ botCount }),
            });
            activeRunId = j.runId;
            setRunStatus(`run ${j.runId} を開始しました`, false);
            const abortBtn = document.getElementById('bench-r1-abort');
            if (abortBtn) abortBtn.disabled = false;
            startPolling();
        } catch (e) {
            setRunStatus(`開始失敗: ${e instanceof Error ? e.message : String(e)}`, true);
            showFailures(/** @type {any} */ (e).failures || [e instanceof Error ? e.message : String(e)]);
        }
    });

    document.getElementById('bench-r1-abort')?.addEventListener('click', async () => {
        if (!activeRunId) return;
        if (!window.confirm('ベンチを中止しますか？')) return;
        try {
            await apiFetch(`${API}/runs/${activeRunId}/abort`, { method: 'POST' });
            setRunStatus('中止を要求しました', true);
            void refreshRunStatus();
        } catch (e) {
            setRunStatus(`中止失敗: ${e instanceof Error ? e.message : String(e)}`, true);
        }
    });
}

function showBenchPanel() {
    document.querySelectorAll('.admin-panel').forEach((el) => el.classList.remove('active'));
    document.querySelectorAll('.admin-nav-item').forEach((el) => el.classList.remove('active'));
    const panel = document.getElementById(PANEL_ID);
    const nav = document.querySelector(`.admin-nav-item[data-panel="${NAV_DATA_PANEL}"]`);
    if (panel) panel.classList.add('active');
    if (nav) nav.classList.add('active');
    document.dispatchEvent(new CustomEvent('admin-panel-activated', { detail: { panelId: NAV_DATA_PANEL } }));
    void refreshRunnerStatus();
    void refreshRunStatus();
}

function initBenchR1Admin() {
    ensurePanelDom();
    document.addEventListener('admin-panel-activated', (e) => {
        if (e.detail?.panelId === NAV_DATA_PANEL) {
            void refreshRunnerStatus();
            void refreshRunStatus();
        }
    });
    document.addEventListener('admin-panel-request', (e) => {
        if (e.detail?.panelId === NAV_DATA_PANEL) showBenchPanel();
    });
    const params = new URLSearchParams(location.search);
    if (params.get('panel') === NAV_DATA_PANEL) showBenchPanel();
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initBenchR1Admin);
} else {
    initBenchR1Admin();
}
