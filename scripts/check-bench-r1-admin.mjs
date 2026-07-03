// scripts/check-bench-r1-admin.mjs — Playwright でベンチR1 管理パネルを検証
import { chromium } from 'playwright';

const BASE = process.env.ADMIN_URL || 'https://metapre.mmh-virtual.jp/admin.html';
const USER = process.env.ADMIN_USER || 'admin';
const PASS = process.env.ADMIN_PASS || '';

if (!PASS) {
    console.error('ADMIN_PASS required');
    process.exit(1);
}

const PANEL_ID = 'panel-addon-meta-bench-r1';

async function main() {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
        httpCredentials: { username: USER, password: PASS },
        ignoreHTTPSErrors: true,
    });
    const page = await context.newPage();

    const consoleLogs = [];
    const pageErrors = [];
    const failedRequests = [];

    page.on('console', (msg) => {
        consoleLogs.push(`[${msg.type()}] ${msg.text()}`);
    });
    page.on('pageerror', (err) => pageErrors.push(String(err)));
    page.on('requestfailed', (req) => {
        failedRequests.push(`${req.method()} ${req.url()} — ${req.failure()?.errorText}`);
    });

    console.log('=== Navigate ===');
    const res = await page.goto(BASE, { waitUntil: 'networkidle', timeout: 60000 });
    console.log('status:', res?.status(), res?.url());

    await page.waitForTimeout(3000);

    const navTexts = await page.locator('.admin-nav-item').allTextContents();
    console.log('=== Nav items ===');
    navTexts.forEach((t) => console.log(' -', t.trim()));

    const benchBtn = page.locator(`.admin-nav-item[data-panel="${PANEL_ID}"]`);
    const benchCount = await benchBtn.count();
    console.log('=== Bench R1 nav button count ===', benchCount);

    const panelExists = await page.locator(`#${PANEL_ID}`).count();
    console.log('=== Bench R1 panel DOM count ===', panelExists);

    const registryLoaded = consoleLogs.some((l) => l.includes('registry-admin') || l.includes('meta-bench'));
    console.log('=== Console mentions registry/bench ===', registryLoaded);

    if (benchCount === 0) {
        console.log('=== Fetch registry-admin.js ===');
        const regRes = await page.request.get(
            new URL('/js/addons/registry-admin.js', BASE).href,
            { httpCredentials: { username: USER, password: PASS } }
        );
        console.log('registry-admin.js status:', regRes.status());

        const addonAdminRes = await page.request.get(
            new URL('/addons/meta-bench-r1/client/admin.js', BASE).href,
            { httpCredentials: { username: USER, password: PASS } }
        );
        console.log('addon admin.js status:', addonAdminRes.status());
        if (addonAdminRes.status() === 200) {
            const body = await addonAdminRes.text();
            console.log('addon admin has showBenchPanel:', body.includes('showBenchPanel'));
            console.log('addon admin has addEventListener click:', body.includes("btn.addEventListener('click'"));
        }
    }

    if (benchCount > 0) {
        console.log('=== Click Bench R1 ===');
        await benchBtn.click();
        await page.waitForTimeout(500);
        let panelActive = await page.locator(`#${PANEL_ID}.active`).count();
        let navActive = await page.locator(`.admin-nav-item[data-panel="${PANEL_ID}"].active`).count();
        console.log('after click panel .active:', panelActive);
        console.log('after click nav .active:', navActive);

        if (panelActive === 0) {
            console.log('=== Try switchPanel via DOM (simulates admin.js delegation fix) ===');
            await page.evaluate((id) => {
                document.querySelectorAll('.admin-panel').forEach((el) => el.classList.remove('active'));
                document.querySelectorAll('.admin-nav-item').forEach((el) => el.classList.remove('active'));
                document.getElementById(id)?.classList.add('active');
                document.querySelector(`.admin-nav-item[data-panel="${id}"]`)?.classList.add('active');
            }, PANEL_ID);
            panelActive = await page.locator(`#${PANEL_ID}.active`).count();
            navActive = await page.locator(`.admin-nav-item[data-panel="${PANEL_ID}"].active`).count();
            console.log('after manual activate panel .active:', panelActive);
            console.log('after manual activate nav .active:', navActive);
        }

        const heading = await page.locator(`#${PANEL_ID} h2`).first().textContent().catch(() => null);
        console.log('heading:', heading?.trim());
    }

    console.log('=== Failed requests (addon/js related) ===');
    failedRequests
        .filter((r) => /addons|registry-admin|meta-bench/i.test(r))
        .forEach((r) => console.log(' ', r));

    console.log('=== Page errors ===');
    pageErrors.forEach((e) => console.log(' ', e));

    console.log('=== Console errors ===');
    consoleLogs.filter((l) => l.startsWith('[error]')).forEach((l) => console.log(' ', l));

    await browser.close();
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
