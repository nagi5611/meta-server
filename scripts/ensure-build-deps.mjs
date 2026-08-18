// scripts/ensure-build-deps.mjs — vite build 前の必須依存チェック
import fs from 'node:fs';
import path from 'node:path';

const projectRoot = process.cwd();
const required = [
    'node_modules/three-mesh-ui/build/three-mesh-ui.module.js',
    'node_modules/@web-ar-studio/webar-engine-sdk/dist/index.mjs',
];

const missing = required.filter((rel) => !fs.existsSync(path.join(projectRoot, rel)));

if (missing.length > 0) {
    console.error('[build] Missing npm dependencies required for vite build:');
    for (const rel of missing) {
        console.error(`  - ${rel}`);
    }
    console.error('[build] Run: npm install');
    console.error('[build] If npm install fails with EACCES on package-lock.json, fix ownership:');
    console.error('[build]   sudo chown -R "$(whoami):$(id -gn)" .');
    process.exit(1);
}
