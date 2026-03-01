import path from 'node:path';
import fs from 'node:fs';
import { defineConfig } from 'vite';

/** ビルド後に public の静的アセット（music, images）だけを dist にコピー。publicDir で丸ごとコピーすると index.html が上書きされ three が解決できなくなるため */
function copyPublicAssets() {
    return {
        name: 'copy-public-assets',
        closeBundle() {
            const cwd = process.cwd();
            const publicDir = path.join(cwd, 'public');
            const distDir = path.join(cwd, 'dist');
            for (const dir of ['music', 'images']) {
                const src = path.join(publicDir, dir);
                const dest = path.join(distDir, dir);
                if (!fs.existsSync(src)) continue;
                fs.mkdirSync(dest, { recursive: true });
                for (const name of fs.readdirSync(src)) {
                    const srcFile = path.join(src, name);
                    if (!fs.statSync(srcFile).isFile()) continue;
                    fs.copyFileSync(srcFile, path.join(dest, name));
                }
            }
        }
    };
}

export default defineConfig({
    root: 'public',
    plugins: [copyPublicAssets()],
    server: {
        port: 3001,
        host: true, // Listen on 0.0.0.0 for LAN access
        open: true,
        proxy: {
            '/socket.io': {
                target: 'http://localhost:3000',
                ws: true,
                changeOrigin: true
            },
            '/api': {
                target: 'http://localhost:3000',
                changeOrigin: true
            },
            '/admin': {
                target: 'http://localhost:3000',
                changeOrigin: true
            },
            '/vendor': {
                target: 'http://localhost:3000',
                changeOrigin: true
            }
        }
    },
    build: {
        outDir: '../dist',
        emptyOutDir: true
    }
});
