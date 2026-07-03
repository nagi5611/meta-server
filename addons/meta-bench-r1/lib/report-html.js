// addons/meta-bench-r1/lib/report-html.js — 日本語 HTML レポート
import os from 'node:os';

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
        failures = [],
        notes = [],
    } = data;

    const rows = Object.entries(scores)
        .map(
            ([id, val]) =>
                `<tr><td>${escapeHtml(id)}</td><td>${val == null ? 'N/A' : escapeHtml(String(Math.round(val)))}</td></tr>`
        )
        .join('');

    const failureList =
        failures.length > 0
            ? `<ul>${failures.map((f) => `<li>${escapeHtml(f)}</li>`).join('')}</ul>`
            : '<p>なし</p>';

    const noteList =
        notes.length > 0
            ? `<ul>${notes.map((n) => `<li>${escapeHtml(n)}</li>`).join('')}</ul>`
            : '';

    return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="utf-8" />
  <title>ベンチレポート ${escapeHtml(runId)}</title>
  <style>
    body { font-family: sans-serif; margin: 2rem; line-height: 1.5; }
    table { border-collapse: collapse; margin: 1rem 0; }
    th, td { border: 1px solid #ccc; padding: 0.4rem 0.8rem; }
    th { background: #f0f0f0; }
    .meta { color: #444; font-size: 0.9rem; }
    .warn { color: #a60; }
  </style>
</head>
<body>
  <h1>meta-bench-r1 ベンチレポート</h1>
  <p class="meta">runId: ${escapeHtml(runId)} / ステータス: ${escapeHtml(status)}</p>
  <p class="meta">開始: ${formatTs(startedAt)} / 終了: ${formatTs(finishedAt)}</p>
  <h2>総合スコア（参考）</h2>
  <p>${overall == null ? 'N/A' : `${Math.round(overall)} / 100`}</p>
  <h2>カテゴリ別スコア</h2>
  <table>
    <thead><tr><th>カテゴリ</th><th>スコア</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
  <h2>サーバ情報</h2>
  <ul class="meta">
    <li>CPU: ${escapeHtml(meta.cpuModel || os.cpus()[0]?.model || 'unknown')}</li>
    <li>コア数: ${escapeHtml(String(meta.cpuCores ?? os.cpus().length))}</li>
    <li>RAM: ${escapeHtml(String(meta.totalMemGb ?? Math.round(os.totalmem() / 1e9)))} GB</li>
    <li>OS: ${escapeHtml(meta.platform || `${os.type()} ${os.release()}`)}</li>
    <li>Node: ${escapeHtml(meta.nodeVersion || process.version)}</li>
    <li>meta-server: ${escapeHtml(meta.coreVersion || '-')}</li>
    <li>有効 addon: ${escapeHtml((meta.loadedAddons || []).join(', ') || '-')}</li>
  </ul>
  <h2>警告・失敗</h2>
  ${failureList}
  ${noteList ? `<h2 class="warn">注記</h2>${noteList}` : ''}
  <p class="warn">bot・WebRTC 系カテゴリは同一マシンでも ±5〜7% 程度ぶれやすい場合があります。</p>
</body>
</html>`;
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
