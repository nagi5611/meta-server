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

            <div class="bench-r1-layout">
                <div class="bench-r1-main">
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
                                <input type="number" id="bench-r1-bot-count" class="bench-r1-input" min="1" max="200" value="25" />
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
                </div>

                <aside class="bench-r1-history card-like" aria-label="過去のベンチ一覧">
                    <div class="bench-r1-history-head">
                        <h3>過去のベンチ</h3>
                        <button type="button" class="btn btn-secondary btn-sm" id="bench-r1-refresh-history" title="一覧を更新">更新</button>
                    </div>
                    <p id="bench-r1-history-status" class="hint bench-r1-history-status">読み込み中…</p>
                    <ul id="bench-r1-history-list" class="bench-r1-history-list"></ul>
                </aside>
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
        .bench-r1-section { max-width: none; }
        .bench-r1-header h2 { margin: 0 0 0.35rem; }
        .bench-r1-lead { margin: 0 0 1rem; line-height: 1.55; }
        .bench-r1-layout {
            display: grid;
            grid-template-columns: minmax(0, 1fr) minmax(260px, 320px);
            gap: 1rem;
            align-items: start;
        }
        @media (max-width: 960px) {
            .bench-r1-layout { grid-template-columns: 1fr; }
            .bench-r1-history { order: 2; }
        }
        .bench-r1-p07 { margin-bottom: 1rem; padding: 1rem; border: 1px solid #e0c080; border-radius: 8px; background: #fffbf0; }
        .bench-r1-p07 h3 { margin: 0 0 0.5rem; font-size: 1rem; color: #a60; }
        .bench-r1-p07 ol { margin: 0; padding-left: 1.25rem; }
        .bench-r1-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; }
        @media (max-width: 800px) { .bench-r1-grid { grid-template-columns: 1fr; } }
        .bench-r1-card.card-like,
        .bench-r1-history.card-like { padding: 1rem; border: 1px solid var(--admin-border, #ddd); border-radius: 8px; background: #fff; }
        .bench-r1-card h3,
        .bench-r1-history h3 { margin: 0 0 0.75rem; font-size: 1.05rem; }
        .bench-r1-label { display: flex; flex-direction: column; gap: 0.35rem; margin-bottom: 0.75rem; font-size: 0.9rem; }
        .bench-r1-input { max-width: 8rem; padding: 0.35rem 0.5rem; }
        .bench-r1-actions { display: flex; flex-wrap: wrap; gap: 0.5rem; margin-bottom: 0.5rem; }
        .bench-r1-failures { margin: 0.5rem 0 0; padding-left: 1.25rem; color: #c62828; font-size: 0.9rem; }
        .status-text.error { color: #c62828; }
        .status-text.success { color: #2e7d32; }
        .bench-r1-history { position: sticky; top: 1rem; max-height: calc(100vh - 6rem); display: flex; flex-direction: column; }
        .bench-r1-history-head { display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; margin-bottom: 0.5rem; }
        .bench-r1-history-head h3 { margin: 0; }
        .bench-r1-history-status { margin: 0 0 0.5rem; font-size: 0.82rem; }
        .bench-r1-history-list {
            list-style: none;
            margin: 0;
            padding: 0;
            overflow-y: auto;
            flex: 1;
            min-height: 0;
        }
        .bench-r1-history-item {
            border: 1px solid var(--admin-border, #e5e5e5);
            border-radius: 6px;
            margin-bottom: 0.5rem;
            background: #fafafa;
        }
        .bench-r1-history-item:last-child { margin-bottom: 0; }
        .bench-r1-history-item.is-active { border-color: #1976d2; box-shadow: 0 0 0 1px #1976d2; }
        .bench-r1-history-btn {
            display: block;
            width: 100%;
            padding: 0.55rem 0.65rem;
            border: 0;
            background: transparent;
            text-align: left;
            cursor: pointer;
            font: inherit;
            color: inherit;
        }
        .bench-r1-history-btn:hover { background: rgba(25, 118, 210, 0.06); }
        .bench-r1-history-row { display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; margin-bottom: 0.2rem; }
        .bench-r1-history-date { font-size: 0.82rem; font-weight: 600; }
        .bench-r1-history-score { font-size: 0.9rem; font-weight: 700; color: #1565c0; }
        .bench-r1-history-meta { font-size: 0.78rem; color: #666; line-height: 1.35; }
        .bench-r1-status-badge {
            display: inline-block;
            padding: 0.1rem 0.4rem;
            border-radius: 4px;
            font-size: 0.72rem;
            font-weight: 600;
            line-height: 1.3;
        }
        .bench-r1-status-completed { background: #e8f5e9; color: #2e7d32; }
        .bench-r1-status-partial { background: #fff3e0; color: #e65100; }
        .bench-r1-status-failed { background: #ffebee; color: #c62828; }
        .bench-r1-status-running { background: #e3f2fd; color: #1565c0; }
        .bench-r1-history-report {
            display: inline-block;
            margin-top: 0.25rem;
            font-size: 0.78rem;
            color: #1565c0;
            text-decoration: none;
        }
        .bench-r1-history-report:hover { text-decoration: underline; }
        body.admin-dark .bench-r1-card.card-like,
        body.admin-dark .bench-r1-history.card-like { background: rgba(255,255,255,0.03); }
        body.admin-dark .bench-r1-history-item { background: rgba(255,255,255,0.02); }
        body.admin-dark .bench-r1-p07 { background: rgba(255, 200, 80, 0.08); }
        body.admin-dark .bench-r1-history-meta { color: #aaa; }
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

/**
 * @param {number | null | undefined} ms
 */
function formatBenchDate(ms) {
    if (!ms) return '—';
    try {
        return new Date(ms).toLocaleString('ja-JP', {
            month: 'numeric',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
        });
    } catch {
        return '—';
    }
}

/**
 * @param {string} status
 */
function benchStatusLabel(status) {
    switch (status) {
        case 'completed':
            return '完了';
        case 'partial':
            return '一部完了';
        case 'failed':
            return '失敗';
        case 'running':
            return '実行中';
        case 'preflight':
            return '準備中';
        default:
            return status || '—';
    }
}

/**
 * @param {string} status
 */
function benchStatusClass(status) {
    if (status === 'completed') return 'bench-r1-status-completed';
    if (status === 'partial') return 'bench-r1-status-partial';
    if (status === 'failed') return 'bench-r1-status-failed';
    return 'bench-r1-status-running';
}

/**
 * @param {object} run
 */
function renderHistoryItem(run) {
    const when = formatBenchDate(run.startedAt || run.createdAt);
    const score =
        typeof run.overallScore === 'number' ? `${Math.round(run.overallScore)}点` : '—';
    const reportUrl = run.reportFilename
        ? `${API}/reports/${encodeURIComponent(run.reportFilename)}`
        : '';
    const activeClass = run.id === activeRunId ? ' is-active' : '';
    const reportLink = reportUrl
        ? `<a class="bench-r1-history-report" href="${escapeHtml(reportUrl)}" target="_blank" rel="noopener" onclick="event.stopPropagation()">レポート</a>`
        : '';

    return `<li class="bench-r1-history-item${activeClass}" data-run-id="${escapeHtml(run.id)}">
        <button type="button" class="bench-r1-history-btn" data-run-id="${escapeHtml(run.id)}">
            <div class="bench-r1-history-row">
                <span class="bench-r1-history-date">${escapeHtml(when)}</span>
                <span class="bench-r1-history-score">${escapeHtml(score)}</span>
            </div>
            <div class="bench-r1-history-meta">
                <span class="bench-r1-status-badge ${benchStatusClass(run.status)}">${escapeHtml(benchStatusLabel(run.status))}</span>
                bots ${escapeHtml(String(run.botCount ?? '-'))}
                · ${escapeHtml(run.id)}
            </div>
            ${reportLink}
        </button>
    </li>`;
}

async function refreshHistoryList() {
    const listEl = document.getElementById('bench-r1-history-list');
    const statusEl = document.getElementById('bench-r1-history-status');
    if (!listEl) return;
    try {
        const j = await apiFetch(`${API}/runs?limit=30`);
        const runs = Array.isArray(j.runs) ? j.runs : [];
        if (statusEl) {
            statusEl.textContent = runs.length ? `${runs.length} 件` : '履歴がありません';
        }
        if (!runs.length) {
            listEl.innerHTML = '<li class="hint" style="padding:0.5rem 0">まだベンチが実行されていません。</li>';
            return;
        }
        listEl.innerHTML = runs.map((run) => renderHistoryItem(run)).join('');
        listEl.querySelectorAll('.bench-r1-history-btn').forEach((btn) => {
            btn.addEventListener('click', () => {
                const id = btn.getAttribute('data-run-id');
                if (id) void selectRunFromHistory(id);
            });
        });
    } catch (e) {
        if (statusEl) {
            statusEl.textContent = `取得失敗: ${e instanceof Error ? e.message : String(e)}`;
        }
        listEl.innerHTML = '';
    }
}

/**
 * @param {string} runId
 */
async function selectRunFromHistory(runId) {
    activeRunId = runId;
    document.querySelectorAll('.bench-r1-history-item').forEach((el) => {
        el.classList.toggle('is-active', el.getAttribute('data-run-id') === runId);
    });
    await refreshRunStatus();
    const abortBtn = document.getElementById('bench-r1-abort');
    try {
        const j = await apiFetch(`${API}/runs/${runId}`);
        const run = j.run;
        if (abortBtn && run) {
            abortBtn.disabled = run.status !== 'running' && run.status !== 'preflight';
        }
        if (run?.status === 'running' || run?.status === 'preflight') {
            startPolling();
        }
    } catch {
        /* ignore */
    }
}

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
            void refreshHistoryList();
        }
        if (run.status === 'failed') {
            stopPolling();
            void refreshHistoryList();
        }
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
    document.getElementById('bench-r1-refresh-history')?.addEventListener('click', () => void refreshHistoryList());
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
        const botCount = parseInt(String(document.getElementById('bench-r1-bot-count')?.value || '25'), 10);
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
        const botCount = parseInt(String(document.getElementById('bench-r1-bot-count')?.value || '25'), 10);
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
            void refreshHistoryList();
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
    void refreshHistoryList();
}

function initBenchR1Admin() {
    ensurePanelDom();
    document.addEventListener('admin-panel-activated', (e) => {
        if (e.detail?.panelId === NAV_DATA_PANEL) {
            void refreshRunnerStatus();
            void refreshRunStatus();
            void refreshHistoryList();
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
