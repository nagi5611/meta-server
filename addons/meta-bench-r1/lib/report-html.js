// addons/meta-bench-r1/lib/report-html.js — 日本語 HTML レポート
import os from 'node:os';

/** @type {Record<string, string>} */
const CATEGORY_LABELS = {
    'hw-cpu': 'CPU（hw-cpu）',
    'hw-mem': 'メモリ（hw-mem）',
    'db-sqlite': 'DB / SQLite',
    'mv-tps': 'マルチプレイヤー TPS',
    'mv-connect': '接続・ping（mv-connect）',
    'mv-degrade': '負荷劣化（mv-degrade）',
    'audio-vc': '音声 VC（audio-vc）',
};

/** @type {Record<string, string>} */
const STATUS_LABELS = {
    completed: '完了',
    partial: '一部完了',
    failed: '失敗',
};

/**
 * @param {object} data
 * @returns {string}
 */
export function buildBenchReportHtml(data) {
    const {
        runId,
        status,
        startedAt,
        finishedAt,
        scores = {},
        overall,
        meta = {},
        metrics = {},
        failures = [],
        notes = [],
    } = data;

    const durationMs =
        startedAt && finishedAt && finishedAt >= startedAt ? finishedAt - startedAt : null;
    const overallRounded = overall == null ? null : Math.round(overall);
    const statusLabel = STATUS_LABELS[status] || status;

    const scoreRows = Object.entries(scores)
        .map(([id, val]) => {
            const num = typeof val === 'number' && Number.isFinite(val) ? Math.round(val) : null;
            const label = CATEGORY_LABELS[id] || id;
            const tier = scoreTier(num);
            const width = num == null ? 0 : Math.max(0, Math.min(100, num));
            return `<tr>
  <td class="cat-name">${escapeHtml(label)}</td>
  <td class="cat-bar"><div class="bar-track"><div class="bar-fill bar-${tier}" style="width:${width}%"></div></div></td>
  <td class="cat-score score-${tier}">${num == null ? 'N/A' : `${num}`}</td>
</tr>`;
        })
        .join('');

    const failureBlock =
        failures.length > 0
            ? `<div class="alert alert-error" role="alert">
  <h3>警告・失敗</h3>
  <ul>${failures.map((f) => `<li>${escapeHtml(f)}</li>`).join('')}</ul>
</div>`
            : `<div class="alert alert-ok"><p>警告・失敗はありません。</p></div>`;

    const noteBlock =
        notes.length > 0
            ? `<div class="alert alert-warn">
  <h3>注記</h3>
  <ul>${notes.map((n) => `<li>${escapeHtml(n)}</li>`).join('')}</ul>
</div>`
            : '';

    const addons = (meta.loadedAddons || []).join(', ') || '-';

    const tick = metrics?.tick;
    const tickDebug = tick?.debug;
    const tickDiag = tick?.diagnosis;
    const tickBlock =
        tickDebug || tick
            ? `<div class="card" style="margin-bottom:1.25rem">
      <h2 class="section-title">TPS 計測診断</h2>
      <div class="server-grid">
        <div class="server-item"><span class="k">minTickPerSec</span><span class="v">${escapeHtml(String(tick?.minTickPerSec ?? '—'))}</span></div>
        <div class="server-item"><span class="k">ルーム別 TPS</span><span class="v"><code>${escapeHtml(JSON.stringify(tick?.byRoom ?? {}))}</code></span></div>
        <div class="server-item"><span class="k">hookInstalled</span><span class="v">${escapeHtml(String(tickDebug?.hookInstalled ?? '—'))}</span></div>
        <div class="server-item"><span class="k">hookCalls</span><span class="v">${escapeHtml(String(tickDebug?.totalHookCalls ?? '—'))}</span></div>
        <div class="server-item"><span class="k">recorded</span><span class="v">${escapeHtml(String(tickDebug?.totalRecordedEmits ?? '—'))}</span></div>
        <div class="server-item"><span class="k">skipped (sampling off)</span><span class="v">${escapeHtml(String(tickDebug?.skippedNotSampling ?? '—'))}</span></div>
        <div class="server-item"><span class="k">sampling</span><span class="v">${escapeHtml(String(tickDebug?.sampling ?? '—'))}</span></div>
        <div class="server-item"><span class="k">maintenance</span><span class="v">${escapeHtml(String(tickDebug?.maintenanceActive ?? '—'))}</span></div>
        <div class="server-item"><span class="k">secondsSampled</span><span class="v">${escapeHtml(String(tickDebug?.secondsSampled ?? '—'))}</span></div>
        <div class="server-item"><span class="k">pid</span><span class="v">${escapeHtml(String(tickDebug?.pid ?? '—'))}</span></div>
        <div class="server-item"><span class="k">activeRunId</span><span class="v">${escapeHtml(String(tickDebug?.activeRunId ?? '—'))}</span></div>
      </div>
      ${tickDiag ? `<p class="tick-diagnosis">${escapeHtml(tickDiag)}</p>` : ''}
    </div>`
            : '';

    return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>ベンチレポート ${escapeHtml(runId)}</title>
  <style>
    :root {
      --bg: #f4f6f9;
      --surface: #ffffff;
      --text: #1a1d26;
      --muted: #5c6370;
      --border: #e2e6ee;
      --accent: #1565c0;
      --accent-soft: #e3f2fd;
      --good: #2e7d32;
      --good-bg: #e8f5e9;
      --mid: #ef6c00;
      --mid-bg: #fff3e0;
      --bad: #c62828;
      --bad-bg: #ffebee;
      --radius: 12px;
      --shadow: 0 2px 12px rgba(26, 29, 38, 0.08);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: "Segoe UI", "Hiragino Sans", "Hiragino Kaku Gothic ProN", Meiryo, sans-serif;
      background: var(--bg);
      color: var(--text);
      line-height: 1.6;
      -webkit-font-smoothing: antialiased;
    }
    .page {
      max-width: 920px;
      margin: 0 auto;
      padding: 2rem 1.25rem 3rem;
    }
    .header {
      display: flex;
      flex-wrap: wrap;
      align-items: flex-start;
      justify-content: space-between;
      gap: 1rem;
      margin-bottom: 1.5rem;
    }
    .header h1 {
      margin: 0;
      font-size: 1.5rem;
      font-weight: 700;
      letter-spacing: -0.02em;
    }
    .header .subtitle {
      margin: 0.35rem 0 0;
      color: var(--muted);
      font-size: 0.875rem;
    }
    .badge {
      display: inline-flex;
      align-items: center;
      padding: 0.35rem 0.85rem;
      border-radius: 999px;
      font-size: 0.8rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .badge-completed { background: var(--good-bg); color: var(--good); }
    .badge-partial { background: var(--mid-bg); color: var(--mid); }
    .badge-failed { background: var(--bad-bg); color: var(--bad); }
    .badge-default { background: var(--accent-soft); color: var(--accent); }
    .grid-top {
      display: grid;
      grid-template-columns: 200px 1fr;
      gap: 1.25rem;
      margin-bottom: 1.25rem;
    }
    @media (max-width: 640px) {
      .grid-top { grid-template-columns: 1fr; }
    }
    .card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      box-shadow: var(--shadow);
      padding: 1.25rem 1.35rem;
    }
    .score-hero {
      text-align: center;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      min-height: 160px;
    }
    .score-hero .label {
      font-size: 0.75rem;
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 0.06em;
      margin-bottom: 0.25rem;
    }
    .score-hero .value {
      font-size: 3rem;
      font-weight: 800;
      line-height: 1;
      letter-spacing: -0.03em;
    }
    .score-hero .value.tier-good { color: var(--good); }
    .score-hero .value.tier-mid { color: var(--mid); }
    .score-hero .value.tier-bad { color: var(--bad); }
    .score-hero .unit { font-size: 1rem; color: var(--muted); font-weight: 500; }
    .meta-dl {
      display: grid;
      grid-template-columns: auto 1fr;
      gap: 0.35rem 1rem;
      margin: 0;
      font-size: 0.875rem;
    }
    .meta-dl dt { color: var(--muted); font-weight: 500; margin: 0; }
    .meta-dl dd { margin: 0; word-break: break-all; }
    h2.section-title {
      margin: 0 0 0.85rem;
      font-size: 1rem;
      font-weight: 700;
      color: var(--text);
    }
    table.score-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.9rem;
    }
    table.score-table th {
      text-align: left;
      padding: 0.55rem 0.65rem;
      border-bottom: 2px solid var(--border);
      color: var(--muted);
      font-size: 0.75rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    table.score-table td {
      padding: 0.65rem 0.65rem;
      border-bottom: 1px solid var(--border);
      vertical-align: middle;
    }
    table.score-table tr:last-child td { border-bottom: none; }
    .cat-name { font-weight: 500; white-space: nowrap; }
    .cat-bar { width: 55%; min-width: 120px; }
    .bar-track {
      height: 8px;
      background: #eceff4;
      border-radius: 999px;
      overflow: hidden;
    }
    .bar-fill {
      height: 100%;
      border-radius: 999px;
      transition: width 0.3s ease;
    }
    .bar-good { background: linear-gradient(90deg, #43a047, #66bb6a); }
    .bar-mid { background: linear-gradient(90deg, #fb8c00, #ffa726); }
    .bar-bad { background: linear-gradient(90deg, #e53935, #ef5350); }
    .bar-na { background: #bdbdbd; }
    .cat-score {
      text-align: right;
      font-weight: 700;
      font-variant-numeric: tabular-nums;
      width: 3.5rem;
    }
    .score-good { color: var(--good); }
    .score-mid { color: var(--mid); }
    .score-bad { color: var(--bad); }
    .score-na { color: var(--muted); }
    .server-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
      gap: 0.5rem 1.5rem;
      font-size: 0.875rem;
    }
    .server-item { display: flex; flex-direction: column; gap: 0.1rem; }
    .server-item .k { color: var(--muted); font-size: 0.75rem; font-weight: 600; }
    .server-item .v { word-break: break-word; }
    .alert {
      border-radius: var(--radius);
      padding: 1rem 1.15rem;
      margin-bottom: 1rem;
    }
    .alert h3 {
      margin: 0 0 0.5rem;
      font-size: 0.9rem;
      font-weight: 700;
    }
    .alert ul { margin: 0; padding-left: 1.2rem; }
    .alert li { margin: 0.25rem 0; }
    .alert-error { background: var(--bad-bg); border: 1px solid #ffcdd2; color: #b71c1c; }
    .alert-warn { background: var(--mid-bg); border: 1px solid #ffe0b2; color: #e65100; }
    .alert-ok { background: var(--good-bg); border: 1px solid #c8e6c9; color: var(--good); }
    .tick-diagnosis {
      margin: 1rem 0 0;
      padding: 0.75rem 1rem;
      background: var(--mid-bg);
      border-radius: 8px;
      font-size: 0.85rem;
      color: #e65100;
    }
    .footer-note {
      margin-top: 1.5rem;
      padding: 0.85rem 1rem;
      background: var(--accent-soft);
      border-radius: 8px;
      font-size: 0.8rem;
      color: #0d47a1;
    }
    @media print {
      body { background: #fff; }
      .page { padding: 0; max-width: none; }
      .card { box-shadow: none; break-inside: avoid; }
    }
  </style>
</head>
<body>
  <div class="page">
    <header class="header">
      <div>
        <h1>meta-bench-r1 ベンチレポート</h1>
        <p class="subtitle">runId: <code>${escapeHtml(runId)}</code></p>
      </div>
      <span class="badge badge-${escapeHtml(statusBadgeClass(status))}">${escapeHtml(statusLabel)}</span>
    </header>

    <div class="grid-top">
      <div class="card score-hero">
        <span class="label">総合スコア（参考）</span>
        <span class="value tier-${overallRounded == null ? 'na' : scoreTier(overallRounded)}">${overallRounded == null ? '—' : overallRounded}</span>
        <span class="unit">${overallRounded == null ? '' : '/ 100'}</span>
      </div>
      <div class="card">
        <dl class="meta-dl">
          <dt>開始</dt><dd>${escapeHtml(formatTs(startedAt))}</dd>
          <dt>終了</dt><dd>${escapeHtml(formatTs(finishedAt))}</dd>
          <dt>所要時間</dt><dd>${escapeHtml(formatDuration(durationMs))}</dd>
        </dl>
      </div>
    </div>

    <div class="card" style="margin-bottom:1.25rem">
      <h2 class="section-title">カテゴリ別スコア</h2>
      <table class="score-table">
        <thead>
          <tr><th>カテゴリ</th><th></th><th style="text-align:right">スコア</th></tr>
        </thead>
        <tbody>${scoreRows}</tbody>
      </table>
    </div>

    <div class="card" style="margin-bottom:1.25rem">
      <h2 class="section-title">サーバ情報</h2>
      <div class="server-grid">
        <div class="server-item"><span class="k">CPU</span><span class="v">${escapeHtml(meta.cpuModel || os.cpus()[0]?.model || 'unknown')}</span></div>
        <div class="server-item"><span class="k">コア数</span><span class="v">${escapeHtml(String(meta.cpuCores ?? os.cpus().length))}</span></div>
        <div class="server-item"><span class="k">RAM</span><span class="v">${escapeHtml(String(meta.totalMemGb ?? Math.round(os.totalmem() / 1e9)))} GB</span></div>
        <div class="server-item"><span class="k">OS</span><span class="v">${escapeHtml(meta.platform || `${os.type()} ${os.release()}`)}</span></div>
        <div class="server-item"><span class="k">Node</span><span class="v">${escapeHtml(meta.nodeVersion || process.version)}</span></div>
        <div class="server-item"><span class="k">meta-server</span><span class="v">${escapeHtml(meta.coreVersion || '-')}</span></div>
        <div class="server-item" style="grid-column:1/-1"><span class="k">有効 addon</span><span class="v">${escapeHtml(addons)}</span></div>
      </div>
    </div>

    ${tickBlock}

    ${failureBlock}
    ${noteBlock}

    <p class="footer-note">bot・WebRTC 系カテゴリは同一マシンでも ±5〜7% 程度ぶれやすい場合があります。再現性のためは同一条件・複数回計測を推奨します。</p>
  </div>
</body>
</html>`;
}

/**
 * @param {number | null} score
 * @returns {'good'|'mid'|'bad'|'na'}
 */
function scoreTier(score) {
    if (score == null || !Number.isFinite(score)) return 'na';
    if (score >= 80) return 'good';
    if (score >= 50) return 'mid';
    return 'bad';
}

/**
 * @param {string} status
 */
function statusBadgeClass(status) {
    if (status === 'completed') return 'completed';
    if (status === 'partial') return 'partial';
    if (status === 'failed') return 'failed';
    return 'default';
}

/**
 * @param {number | null} ms
 */
function formatDuration(ms) {
    if (ms == null || ms < 0) return '-';
    const sec = Math.round(ms / 1000);
    if (sec < 60) return `${sec} 秒`;
    const min = Math.floor(sec / 60);
    const rem = sec % 60;
    return rem > 0 ? `${min} 分 ${rem} 秒` : `${min} 分`;
}

/**
 * @param {number | null | undefined} ts
 */
function formatTs(ts) {
    if (!ts) return '-';
    return new Date(ts).toLocaleString('ja-JP');
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
 * @param {Date} date
 * @returns {string}
 */
export function benchReportFilename(date = new Date()) {
    const pad = (n) => String(n).padStart(2, '0');
    return `benchreport${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}.html`;
}
