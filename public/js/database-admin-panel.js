// public/js/database-admin-panel.js — 管理画面「データベース」タブ（SQLite 閲覧）

const PAGE_SIZE = 50;

/** @type {boolean} */
let mounted = false;

/** @type {{ id: string, label: string, group: string, fileName: string, exists: boolean }[]|null} */
let databases = null;

/** @type {string|null} */
let selectedDbId = null;

/** @type {string|null} */
let selectedTable = null;

/** @type {'browse'|'sql'} */
let mainMode = 'browse';

/** @type {number} */
let rowOffset = 0;

/** @type {string|null} */
let orderBy = null;

/** @type {'ASC'|'DESC'} */
let orderDir = 'ASC';

/**
 * @param {string} path
 * @param {RequestInit} [init]
 */
async function apiFetch(path, init) {
    const r = await fetch(path, { credentials: 'include', ...init });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
        const err = new Error(j.error || `HTTP ${r.status}`);
        /** @type {Error & { status?: number }} */ (err).status = r.status;
        throw err;
    }
    return j;
}

/**
 * @param {number} bytes
 */
function formatBytes(bytes) {
    if (bytes == null || !Number.isFinite(bytes)) return '—';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/**
 * @param {number} ms
 */
function formatMtime(ms) {
    if (!ms) return '—';
    try {
        return new Date(ms).toLocaleString('ja-JP');
    } catch {
        return '—';
    }
}

/**
 * @param {unknown} v
 */
function escapeHtml(v) {
    return String(v ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/**
 * @param {Record<string, { value: unknown, redacted?: boolean }>} row
 * @param {string[]} columns
 */
function rowToCells(row, columns) {
    return columns.map((col) => {
        const cell = row[col];
        const val = cell?.value;
        const redacted = cell?.redacted;
        let text = val === null || val === undefined ? '' : String(val);
        if (text.length > 500) text = `${text.slice(0, 500)}…`;
        const cls = redacted ? 'db-cell-redacted' : '';
        return `<td class="${cls}" title="${escapeHtml(text)}">${escapeHtml(text)}</td>`;
    });
}

/**
 * データグリッド HTML
 * @param {string[]} columns
 * @param {Record<string, { value: unknown, redacted?: boolean }>[]} rows
 */
function renderDataTable(columns, rows) {
    if (!columns.length) {
        return '<p class="db-empty">列がありません。</p>';
    }
    const head = columns.map((c) => `<th>${escapeHtml(c)}</th>`).join('');
    const body = rows.length
        ? rows.map((r) => `<tr>${rowToCells(r, columns).join('')}</tr>`).join('')
        : `<tr><td colspan="${columns.length}" class="db-empty-cell">行がありません</td></tr>`;
    return `<div class="db-table-wrap"><table class="db-data-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

function setStatus(msg, isError = false) {
    const el = document.getElementById('db-explorer-status');
    if (!el) return;
    el.textContent = msg || '';
    el.classList.toggle('db-status-error', isError);
}

async function loadDatabases() {
    const j = await apiFetch('/admin/database/databases');
    databases = j.databases || [];
    renderDatabaseList();
}

function renderDatabaseList() {
    const list = document.getElementById('db-explorer-db-list');
    if (!list || !databases) return;
    const core = databases.filter((d) => d.group === 'core');
    const plugins = databases.filter((d) => d.group === 'plugin');

    const itemHtml = (d) => {
        const active = d.id === selectedDbId ? ' active' : '';
        const missing = d.exists ? '' : ' db-db-missing';
        const meta = d.exists ? formatBytes(d.sizeBytes) : '未作成';
        return `<button type="button" class="db-db-item${active}${missing}" data-db-id="${escapeHtml(d.id)}" title="${escapeHtml(d.fileName)}">
            <span class="db-db-label">${escapeHtml(d.label)}</span>
            <span class="db-db-meta">${escapeHtml(meta)}</span>
        </button>`;
    };

    list.innerHTML = `
        <div class="db-db-group">
            <div class="db-db-group-title">コア</div>
            ${core.map(itemHtml).join('') || '<p class="db-empty">なし</p>'}
        </div>
        <div class="db-db-group">
            <div class="db-db-group-title">アドオン</div>
            ${plugins.map(itemHtml).join('') || '<p class="db-empty">plugin-databases/*.db なし</p>'}
        </div>
    `;

    list.querySelectorAll('.db-db-item').forEach((btn) => {
        btn.addEventListener('click', () => {
            const id = btn.getAttribute('data-db-id');
            if (id) void selectDatabase(id);
        });
    });
}

async function selectDatabase(dbId) {
    selectedDbId = dbId;
    selectedTable = null;
    rowOffset = 0;
    orderBy = null;
    orderDir = 'ASC';
    renderDatabaseList();
    await loadTables();
    renderMainEmpty('テーブルを選択してください');
}

async function loadTables() {
    const list = document.getElementById('db-explorer-table-list');
    if (!list || !selectedDbId) {
        if (list) list.innerHTML = '';
        return;
    }
    list.innerHTML = '<p class="db-loading">読み込み中…</p>';
    try {
        const enc = encodeURIComponent(selectedDbId);
        const j = await apiFetch(`/admin/database/databases/${enc}/tables`);
        if (j.missing) {
            list.innerHTML = '<p class="db-empty">データベースファイルがありません。</p>';
            return;
        }
        const tables = j.tables || [];
        list.innerHTML = tables.length
            ? tables
                  .map((t) => {
                      const active = t.name === selectedTable ? ' active' : '';
                      const cnt =
                          t.rowCount != null ? `${t.rowCount} 行` : '';
                      return `<button type="button" class="db-table-item${active}" data-table="${escapeHtml(t.name)}">
                        <span class="db-table-name">${escapeHtml(t.name)}</span>
                        <span class="db-table-meta">${escapeHtml(t.type)} ${escapeHtml(cnt)}</span>
                    </button>`;
                  })
                  .join('')
            : '<p class="db-empty">テーブルがありません</p>';

        list.querySelectorAll('.db-table-item').forEach((btn) => {
            btn.addEventListener('click', () => {
                const name = btn.getAttribute('data-table');
                if (name) void selectTable(name);
            });
        });
    } catch (e) {
        list.innerHTML = `<p class="db-empty db-status-error">${escapeHtml(e.message)}</p>`;
    }
}

function renderMainEmpty(msg) {
    const main = document.getElementById('db-explorer-main');
    if (!main) return;
    main.innerHTML = `<p class="db-empty db-main-placeholder">${escapeHtml(msg)}</p>`;
}

async function selectTable(tableName) {
    selectedTable = tableName;
    mainMode = 'browse';
    rowOffset = 0;
    document.querySelectorAll('.db-mode-btn').forEach((b) => {
        b.classList.toggle('active', b.getAttribute('data-db-mode') === 'browse');
    });
    await loadTables();
    await loadTableData();
}

async function loadTableSchema() {
    if (!selectedDbId || !selectedTable) return '';
    const enc = encodeURIComponent(selectedDbId);
    const j = await apiFetch(
        `/admin/database/databases/${enc}/tables/${encodeURIComponent(selectedTable)}/schema`
    );
    const cols = j.schema?.columns || [];
    if (!cols.length) return '';
    const rows = cols
        .map(
            (c) =>
                `<tr><td>${escapeHtml(c.name)}</td><td>${escapeHtml(c.type)}</td><td>${c.pk ? 'PK' : ''}</td><td>${c.notnull ? 'NOT NULL' : ''}</td><td>${escapeHtml(c.dflt_value ?? '')}</td></tr>`
        )
        .join('');
    return `<details class="db-schema-details" open>
        <summary>スキーマ</summary>
        <div class="db-table-wrap"><table class="db-schema-table"><thead><tr><th>列</th><th>型</th><th></th><th></th><th>既定</th></tr></thead><tbody>${rows}</tbody></table></div>
    </details>`;
}

async function loadTableData() {
    const main = document.getElementById('db-explorer-main');
    if (!main || !selectedDbId || !selectedTable) return;
    main.innerHTML = '<p class="db-loading">読み込み中…</p>';
    setStatus('');

    try {
        const params = new URLSearchParams({
            offset: String(rowOffset),
            limit: String(PAGE_SIZE),
        });
        if (orderBy) {
            params.set('orderBy', orderBy);
            params.set('orderDir', orderDir);
        }
        const enc = encodeURIComponent(selectedDbId);
        const j = await apiFetch(
            `/admin/database/databases/${enc}/tables/${encodeURIComponent(selectedTable)}/rows?${params}`
        );
        const columns = j.columns || [];
        const rows = j.rows || [];
        const total = j.total ?? 0;
        const schemaHtml = await loadTableSchema();

        const pageStart = total === 0 ? 0 : rowOffset + 1;
        const pageEnd = Math.min(rowOffset + PAGE_SIZE, total);
        const canPrev = rowOffset > 0;
        const canNext = rowOffset + PAGE_SIZE < total;

        const sortBtns = columns
            .slice(0, 8)
            .map((c) => {
                const active = orderBy === c;
                const dir = active ? orderDir : '';
                return `<button type="button" class="db-sort-chip${active ? ' active' : ''}" data-sort-col="${escapeHtml(c)}">${escapeHtml(c)}${dir ? ` ${dir}` : ''}</button>`;
            })
            .join('');

        main.innerHTML = `
            <div class="db-main-header">
                <h2 class="db-main-title">${escapeHtml(selectedTable)}</h2>
                <span class="db-main-meta">${pageStart}–${pageEnd} / ${total} 行</span>
            </div>
            ${schemaHtml}
            <div class="db-sort-bar" title="クリックでソート（最大8列）">${sortBtns}</div>
            ${renderDataTable(columns, rows)}
            <div class="db-pager">
                <button type="button" class="btn btn-secondary db-pager-prev" ${canPrev ? '' : 'disabled'}>前へ</button>
                <button type="button" class="btn btn-secondary db-pager-next" ${canNext ? '' : 'disabled'}>次へ</button>
                <button type="button" class="btn btn-secondary db-pager-refresh">更新</button>
            </div>
        `;

        main.querySelector('.db-pager-prev')?.addEventListener('click', () => {
            rowOffset = Math.max(0, rowOffset - PAGE_SIZE);
            void loadTableData();
        });
        main.querySelector('.db-pager-next')?.addEventListener('click', () => {
            rowOffset += PAGE_SIZE;
            void loadTableData();
        });
        main.querySelector('.db-pager-refresh')?.addEventListener('click', () => void loadTableData());

        main.querySelectorAll('.db-sort-chip').forEach((btn) => {
            btn.addEventListener('click', () => {
                const col = btn.getAttribute('data-sort-col');
                if (!col) return;
                if (orderBy === col) {
                    orderDir = orderDir === 'ASC' ? 'DESC' : 'ASC';
                } else {
                    orderBy = col;
                    orderDir = 'ASC';
                }
                rowOffset = 0;
                void loadTableData();
            });
        });
    } catch (e) {
        main.innerHTML = `<p class="db-empty db-status-error">${escapeHtml(e.message)}</p>`;
    }
}

function showSqlPanel() {
    mainMode = 'sql';
    const main = document.getElementById('db-explorer-main');
    if (!main) return;
    const dbLabel = selectedDbId || '（データベース未選択）';
    main.innerHTML = `
        <div class="db-main-header">
            <h2 class="db-main-title">SQL クエリ</h2>
            <span class="db-main-meta">${escapeHtml(dbLabel)}</span>
        </div>
        <p class="db-sql-hint">読み取り専用: SELECT / WITH のみ。最大 ${200} 行。password_hash 等はマスクされます。</p>
        <textarea id="db-sql-input" class="db-sql-input" rows="6" spellcheck="false" placeholder="SELECT * FROM students LIMIT 10"></textarea>
        <div class="db-sql-actions">
            <button type="button" class="btn btn-primary" id="db-sql-run">実行</button>
        </div>
        <div id="db-sql-result"></div>
    `;
    document.getElementById('db-sql-run')?.addEventListener('click', () => void runSqlQuery());
}

async function runSqlQuery() {
    if (!selectedDbId) {
        setStatus('先にデータベースを選択してください', true);
        return;
    }
    const ta = document.getElementById('db-sql-input');
    const out = document.getElementById('db-sql-result');
    if (!ta || !out) return;
    const sql = ta.value.trim();
    if (!sql) return;
    out.innerHTML = '<p class="db-loading">実行中…</p>';
    setStatus('');
    try {
        const j = await apiFetch('/admin/database/query', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ dbId: selectedDbId, sql }),
        });
        const columns = j.columns || [];
        const rows = j.rows || [];
        const trunc = j.truncated ? `<p class="db-sql-warn">結果は ${j.rowCount} 行。表示は先頭 200 行まで。</p>` : '';
        out.innerHTML = `${trunc}${renderDataTable(columns, rows)}`;
    } catch (e) {
        out.innerHTML = `<p class="db-empty db-status-error">${escapeHtml(e.message)}</p>`;
    }
}

function bindChrome() {
    document.getElementById('db-explorer-refresh')?.addEventListener('click', () => {
        void (async () => {
            setStatus('更新中…');
            try {
                await loadDatabases();
                if (selectedDbId) await loadTables();
                if (selectedTable && mainMode === 'browse') await loadTableData();
                setStatus('');
            } catch (e) {
                setStatus(e.message, true);
            }
        })();
    });

    document.querySelectorAll('.db-mode-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
            const mode = btn.getAttribute('data-db-mode');
            document.querySelectorAll('.db-mode-btn').forEach((b) => b.classList.remove('active'));
            btn.classList.add('active');
            if (mode === 'sql') {
                showSqlPanel();
            } else {
                mainMode = 'browse';
                if (selectedTable) void loadTableData();
                else renderMainEmpty('テーブルを選択してください');
            }
        });
    });
}

/**
 * 管理画面「データベース」タブを初期化する
 */
export function initDatabaseAdminPanel() {
    if (mounted) return;
    const root = document.getElementById('panel-database');
    if (!root) return;
    mounted = true;

    root.innerHTML = `
        <div class="db-explorer">
            <header class="db-explorer-toolbar">
                <h1 class="db-explorer-title"><i class="bi bi-database"></i> データベース</h1>
                <div class="db-explorer-toolbar-actions">
                    <div class="db-mode-tabs">
                        <button type="button" class="db-mode-btn active" data-db-mode="browse">テーブル</button>
                        <button type="button" class="db-mode-btn" data-db-mode="sql">SQL</button>
                    </div>
                    <button type="button" class="btn btn-secondary" id="db-explorer-refresh"><i class="bi bi-arrow-clockwise"></i> 更新</button>
                </div>
            </header>
            <p id="db-explorer-status" class="db-explorer-status" role="status"></p>
            <div class="db-explorer-body">
                <aside class="db-explorer-col db-explorer-databases">
                    <div class="db-col-title">データベース</div>
                    <div id="db-explorer-db-list" class="db-list-scroll"></div>
                </aside>
                <aside class="db-explorer-col db-explorer-tables">
                    <div class="db-col-title">テーブル</div>
                    <div id="db-explorer-table-list" class="db-list-scroll"></div>
                </aside>
                <section class="db-explorer-col db-explorer-main-col">
                    <div id="db-explorer-main" class="db-explorer-main">
                        <p class="db-empty db-main-placeholder">データベースを選択してください</p>
                    </div>
                </section>
            </div>
        </div>
    `;

    bindChrome();
    void loadDatabases().catch((e) => setStatus(e.message, true));
}
