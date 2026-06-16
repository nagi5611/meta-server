import path from 'node:path';
import fs from 'node:fs';
import { defineConfig } from 'vite';

/**
 * ディレクトリを再帰コピー（ファイルのみ。シンボリックリンクは辿らない）
 * @param {string} srcDir
 * @param {string} destDir
 */
function copyDirRecursive(srcDir, destDir) {
    if (!fs.existsSync(srcDir)) return;
    fs.mkdirSync(destDir, { recursive: true });
    for (const name of fs.readdirSync(srcDir)) {
        const srcPath = path.join(srcDir, name);
        const destPath = path.join(destDir, name);
        const stat = fs.statSync(srcPath);
        if (stat.isDirectory()) {
            copyDirRecursive(srcPath, destPath);
            continue;
        }
        if (!stat.isFile()) continue;
        fs.mkdirSync(path.dirname(destPath), { recursive: true });
        fs.copyFileSync(srcPath, destPath);
    }
}

/** ビルド後に public の静的アセットを dist にコピー。publicDir で丸ごとコピーすると index.html が上書きされ three が解決できなくなるため */
function copyPublicAssets() {
    return {
        name: 'copy-public-assets',
        closeBundle() {
            const cwd = process.cwd();
            const publicDir = path.join(cwd, 'public');
            const distDir = path.join(cwd, 'dist');
            const addonsDir = path.join(cwd, 'addons');

            for (const dir of ['music', 'images', 'env']) {
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

            copyDirRecursive(path.join(publicDir, 'js'), path.join(distDir, 'js'));
            copyDirRecursive(path.join(publicDir, 'css'), path.join(distDir, 'css'));
            copyDirRecursive(path.join(publicDir, 'instance'), path.join(distDir, 'instance'));
            copyDirRecursive(addonsDir, path.join(distDir, 'addons'));

            for (const htmlName of ['admin.html', 'sw.js']) {
                const src = path.join(publicDir, htmlName);
                const dest = path.join(distDir, htmlName);
                if (fs.existsSync(src)) {
                    fs.copyFileSync(src, dest);
                }
            }
        },
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
                changeOrigin: true,
            },
            '/api': {
                target: 'http://localhost:3000',
                changeOrigin: true,
            },
            '/admin': {
                target: 'http://localhost:3000',
                changeOrigin: true,
            },
            '/models': {
                target: 'http://localhost:3000',
                changeOrigin: true,
            },
            '/pdfs': {
                target: 'http://localhost:3000',
                changeOrigin: true,
            },
            '/images': {
                target: 'http://localhost:3000',
                changeOrigin: true,
            },
            '/env': {
                target: 'http://localhost:3000',
                changeOrigin: true,
            },
            '/vendor': {
                target: 'http://localhost:3000',
                changeOrigin: true,
            },
            '/addons': {
                target: 'http://localhost:3000',
                changeOrigin: true,
            },
            '/js': {
                target: 'http://localhost:3000',
                changeOrigin: true,
            },
        },
    },
    build: {
        outDir: '../dist',
        emptyOutDir: true,
    },
});
