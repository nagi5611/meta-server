#!/usr/bin/env node
// scripts/install-bench-aiortc.mjs — Linux/WSL 向け mediasoup-client-aiortc インストール
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

if (os.platform() === 'win32') {
    console.error(
        '[bench:install-aiortc] mediasoup-client-aiortc は Windows ではビルドできません。'
    );
    console.error('WSL または Linux のリポジトリ root で同じコマンドを実行してください:');
    console.error('  npm run bench:install-aiortc');
    process.exit(1);
}

const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const result = spawnSync(
    npmCmd,
    ['install', '--no-fund', '--no-audit', 'mediasoup-client-aiortc@^3.14.7'],
    { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' }
);

if (result.status !== 0) {
    process.exit(result.status ?? 1);
}

console.log('[bench:install-aiortc] mediasoup-client-aiortc をインストールしました。');
