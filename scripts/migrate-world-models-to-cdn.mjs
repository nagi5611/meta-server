/**
 * scripts/migrate-world-models-to-cdn.mjs — worlds.json 内の models/ 相対パスを CDN 絶対 URL へ一括置換
 * 使い方: node scripts/migrate-world-models-to-cdn.mjs <path-to-worlds.json> <META_CDN_PUBLIC_BASE>
 * 例: node scripts/migrate-world-models-to-cdn.mjs ./data/worlds.json https://d111111abcdef8.cloudfront.net/prod
 */

import fs from 'fs';

const worldsPath = process.argv[2];
const cdnBase = (process.argv[3] || '').replace(/\/+$/, '');

if (!worldsPath || !cdnBase || !cdnBase.startsWith('https://')) {
    console.error('Usage: node scripts/migrate-world-models-to-cdn.mjs <worlds.json> <CDN_BASE_HTTPS>');
    process.exit(1);
}

function toCdnUrl(rel) {
    const p = String(rel || '').trim().replace(/^\/+/, '').replace(/\\/g, '/');
    if (!p.toLowerCase().startsWith('models/')) return rel;
    const enc = p.split('/').map((s) => encodeURIComponent(s)).join('/');
    return `${cdnBase}/${enc}`;
}

function migrateWorldsObj(obj) {
    if (!obj || typeof obj !== 'object') return;
    for (const w of Object.values(obj)) {
        if (!w || typeof w !== 'object') continue;
        const models = Array.isArray(w.models) ? w.models : null;
        if (!models) continue;
        for (const m of models) {
            if (!m || typeof m !== 'object') continue;
            if (typeof m.path === 'string' && !m.path.startsWith('http')) {
                m.path = toCdnUrl(m.path);
            }
            if (typeof m.prefabManifest === 'string' && !m.prefabManifest.startsWith('http')) {
                m.prefabManifest = toCdnUrl(m.prefabManifest);
            }
            if (typeof m.mtlPath === 'string' && !m.mtlPath.startsWith('http')) {
                m.mtlPath = toCdnUrl(m.mtlPath);
            }
        }
    }
}

const data = JSON.parse(raw);
const bak = worldsPath + '.bak.' + Date.now();
fs.copyFileSync(worldsPath, bak);
console.log('Backup:', bak);

migrateWorldsObj(data);

fs.writeFileSync(worldsPath, JSON.stringify(data, null, 2), 'utf8');
console.log('Updated:', worldsPath);
