// addons/meta-bench-r1/lib/bench-pdf-path.js — pdf-vc-join 用 PDF パス正規化

/** @type {string} PDFS_DIR 直下の既定ベンチ用 PDF */
export const DEFAULT_BENCH_PDF_PATH = 'bench-sample.pdf';

/**
 * pdf-vc-join に渡す PDF パスを PDFS_DIR からの相対パスへ正規化する。
 * HTTP 配信 URL（/pdfs/foo.pdf）や pdfs/foo.pdf 形式も受け付ける。
 * @param {unknown} input
 * @param {string} [fallback]
 * @returns {string}
 */
export function normalizeBenchPdfPath(input, fallback = DEFAULT_BENCH_PDF_PATH) {
    const raw = typeof input === 'string' && input.trim() ? input.trim() : fallback;
    let p = raw.replace(/\\/g, '/').replace(/^\/+/, '');
    if (p.toLowerCase().startsWith('pdfs/')) {
        p = p.slice('pdfs/'.length);
    }
    if (!p || !p.toLowerCase().endsWith('.pdf') || p.includes('..') || p.includes('/')) {
        return fallback;
    }
    return p;
}
