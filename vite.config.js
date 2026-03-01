import path from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
    root: 'public',
    // ビルド時に public 配下（music/, images/ 等）を dist にコピー。root が public のため絶対パスで指定
    publicDir: path.resolve(process.cwd(), 'public'),
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
