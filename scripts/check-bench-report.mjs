// scripts/check-bench-report.mjs — Playwright でベンチレポート HTML を検証
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildBenchReportHtml } from '../addons/meta-bench-r1/lib/report-html.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPORT_URL =
    process.env.REPORT_URL ||
    'https://metapre.mmh-virtual.jp/admin/addons/meta-bench-r1/reports/benchreport20260703-0900.html';
const USER = process.env.ADMIN_USER || 'admin';
const PASS = process.env.ADMIN_PASS || '';
const OUT_DIR = path.join(__dirname, '..', 'addons', 'meta-bench-r1', 'reports');

async function previewLocal() {
    const html = buildBenchReportHtml({
        runId: 'd17d07ef2c65fcd8',
        status: 'partial',
        startedAt: new Date('2026-07-03T08:55:16+09:00').getTime(),
        finishedAt: new Date('2026-07-03T09:00:01+09:00').getTime(),
        overall: 42,
        scores: {
            'hw-cpu': 70,
            'hw-mem': 100,
            'db-sqlite': 97,
            'mv-tps': 0,
            'mv-connect': 0,
            'mv-degrade': 30,
            'audio-vc': 0,
        },
        meta: {
            cpuModel: 'Intel(R) Celeron(R) CPU 3215U @ 1.70GHz',
            cpuCores: 2,
            totalMemGb: 8,
            platform: 'Linux 6.8.0-124-generic',
            nodeVersion: 'v22.22.0',
            coreVersion: '1.0.0',
            loadedAddons: [
                'admin-reboot',
                'aircraft',
                'meta-bench-r1',
                'nfc-spawn',
            ],
        },
        failures: [
            'Runner から mv-connect メトリクスが届きませんでした。',
            'Runner から audio-vc メトリクスが届きませんでした。',
        ],
    });
    const out = path.join(OUT_DIR, '_preview-design.html');
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(out, html, 'utf8');
    return out;
}

async function main() {
    const previewPath = await previewLocal();
    console.log('Local preview:', previewPath);

    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
        httpCredentials: PASS ? { username: USER, password: PASS } : undefined,
        ignoreHTTPSErrors: true,
        viewport: { width: 960, height: 1200 },
    });
    const page = await context.newPage();

    if (PASS) {
        console.log('=== Remote report ===', REPORT_URL);
        const res = await page.goto(REPORT_URL, { waitUntil: 'networkidle', timeout: 60000 });
        console.log('status:', res?.status());
        const hasCard = await page.locator('.card').count();
        const hasBar = await page.locator('.bar-fill').count();
        const hasBadge = await page.locator('.badge').count();
        console.log('cards:', hasCard, 'bars:', hasBar, 'badge:', hasBadge);
        const shotRemote = path.join(OUT_DIR, '_screenshot-remote.png');
        await page.screenshot({ path: shotRemote, fullPage: true });
        console.log('screenshot:', shotRemote);
    } else {
        console.log('ADMIN_PASS unset — skip remote, preview local only');
    }

    const previewUrl = `file:///${previewPath.replace(/\\/g, '/')}`;
    await page.goto(previewUrl);
    const checks = {
        scoreHero: await page.locator('.score-hero .value').textContent(),
        badge: await page.locator('.badge').textContent(),
        tableRows: await page.locator('table.score-table tbody tr').count(),
        alert: await page.locator('.alert-error').count(),
    };
    console.log('=== Local preview checks ===', checks);
    const shotLocal = path.join(OUT_DIR, '_screenshot-preview.png');
    await page.screenshot({ path: shotLocal, fullPage: true });
    console.log('screenshot:', shotLocal);

    await browser.close();
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
