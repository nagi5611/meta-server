#!/usr/bin/env node
// addons/meta-bench-r1/runner/serve.js — Bench Runner CLI
import os from 'node:os';
import { io } from 'socket.io-client';
import { runSocketBotPool } from './socket-bot-pool.js';
import { runMediasoupBotPool } from './mediasoup-bot-pool.js';
import { ensureMediasoupWorker, getMediasoupMode } from './aiortc-worker.js';
import {
    configureRunnerDebug,
    runnerDebug,
    runnerInfo,
    runnerWarn,
    runnerError,
    formatError,
    maskSecret,
    isRunnerDebug,
} from './debug.js';
import { buildSocketIoOptions } from './socket-client-options.js';
import { collectRunnerHostInfo } from './host-info.js';

/**
 * @param {string[]} argv
 */
function parseArgs(argv) {
    /** @type {Record<string, string | boolean>} */
    const out = { debug: false };
    for (let i = 2; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--debug') out.debug = true;
        else if (a === '--server' && argv[i + 1]) out.server = argv[++i];
        else if (a === '--secret' && argv[i + 1]) out.secret = argv[++i];
        else if (a === '--pairing' && argv[i + 1]) out.pairing = argv[++i];
        else if (a === '--name' && argv[i + 1]) out.name = argv[++i];
        else if (a === '--max-bots' && argv[i + 1]) out.maxBots = argv[++i];
    }
    return out;
}

/**
 * @param {string} base
 * @param {string} path
 * @param {object} body
 * @param {string} [auth]
 * @param {string} [label]
 */
async function postJson(base, path, body, auth, label = 'http') {
    const url = `${base}${path}`;
    runnerDebug('http', `POST ${path}`, {
        label,
        bodyKeys: Object.keys(body || {}),
        auth: auth ? maskSecret(auth) : undefined,
    });
    const headers = { 'Content-Type': 'application/json' };
    if (auth) headers.Authorization = `Bearer ${auth}`;
    let res;
    try {
        res = await fetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
        });
    } catch (e) {
        runnerError('http', `POST ${path} network error`, formatError(e));
        throw e;
    }
    const text = await res.text();
    /** @type {Record<string, unknown>} */
    let json = {};
    try {
        json = text ? JSON.parse(text) : {};
    } catch {
        runnerWarn('http', `POST ${path} non-JSON response`, { status: res.status, text: text.slice(0, 200) });
    }
    if (!res.ok) {
        runnerError('http', `POST ${path} failed`, {
            status: res.status,
            error: json.error || text.slice(0, 200),
        });
        throw new Error(String(json.error || `HTTP ${res.status}`));
    }
    runnerDebug('http', `POST ${path} ok`, { status: res.status, keys: Object.keys(json) });
    return json;
}

async function main() {
    const args = parseArgs(process.argv);
    configureRunnerDebug(!!args.debug);

    const server = String(args.server || 'http://localhost:3000').replace(/\/$/, '');
    const name = String(args.name || 'bench-runner');
    const maxBots = parseInt(String(args.maxBots || '50'), 10);

    runnerInfo('main', 'starting', {
        server,
        name,
        maxBots,
        auth: args.pairing ? `pairing:${args.pairing}` : maskSecret(String(args.secret || '')),
        debug: !!args.debug,
    });

    if (os.platform() !== 'win32') {
        await ensureMediasoupWorker();
        if (getMediasoupMode() === 'fake') {
            runnerWarn(
                'main',
                'mediasoup-client-aiortc が未インストールです。リポジトリ root で npm run bench:install-aiortc を実行してください。'
            );
        } else {
            runnerInfo('main', 'mediasoup-client-aiortc ready');
        }
    }

    const registerBody = {
        name,
        recommendedMaxBots: maxBots,
        hostInfo: collectRunnerHostInfo({
            name,
            recommendedMaxBots: maxBots,
            mediasoupMode: os.platform() === 'win32' ? 'fake' : getMediasoupMode(),
        }),
    };
    if (args.pairing) registerBody.pairingCode = String(args.pairing);
    else if (args.secret) registerBody.runnerSecret = String(args.secret);
    else {
        console.error(
            'Usage: node serve.js --server URL (--secret SECRET | --pairing CODE) [--name NAME] [--max-bots N] [--debug]'
        );
        process.exit(1);
    }

    try {
        const reg = await postJson(server, '/api/addons/meta-bench-r1/runner/register', registerBody, undefined, 'register');
        runnerInfo('main', 'registered', reg.runner || reg);
    } catch (e) {
        runnerError('main', 'register failed — Runner はサーバーに登録されていません', formatError(e));
        process.exit(1);
    }

    const heartbeatIv = setInterval(() => {
        if (!args.secret) {
            runnerDebug('heartbeat', 'skipped (pairing mode, no secret)');
            return;
        }
        postJson(
            server,
            '/api/addons/meta-bench-r1/runner/heartbeat',
            { name },
            String(args.secret),
            'heartbeat'
        ).catch((e) => runnerWarn('heartbeat', 'failed', formatError(e)));
    }, 25_000);

    const socket = io(
        server,
        buildSocketIoOptions(server, args.secret ? { runnerSecret: String(args.secret) } : {}, {
            reconnection: true,
            reconnectionAttempts: 10,
        })
    );

    socket.io.on('error', (e) => runnerError('socket', 'io engine error', formatError(e)));
    socket.io.on('reconnect_attempt', (n) => runnerDebug('socket', `reconnect attempt #${n}`));
    socket.io.on('reconnect', (n) => runnerInfo('socket', `reconnected after ${n} attempts`));
    socket.io.on('reconnect_failed', () => runnerError('socket', 'reconnect failed (gave up)'));

    socket.on('connect', () => {
        runnerInfo('socket', 'connected', { id: socket.id, transport: socket.io.engine?.transport?.name });
        if (args.secret) {
            socket.emit('addon:meta-bench-r1:runner-attach', { runnerSecret: String(args.secret), name }, (ack) => {
                if (ack?.ok) runnerInfo('socket', 'runner-attach ok', ack);
                else runnerError('socket', 'runner-attach failed', ack || '(no ack)');
            });
        } else {
            runnerWarn('socket', 'runner-attach skipped (pairing only — ジョブ受信できない場合があります)');
        }
    });

    socket.on('disconnect', (reason) => {
        runnerWarn('socket', 'disconnected', { reason });
    });

    socket.on('connect_error', (e) => {
        runnerError('socket', 'connect_error', formatError(e));
        if (isRunnerDebug() && e && typeof e === 'object') {
            const detail = /** @type {Record<string, unknown>} */ (e);
            runnerDebug('socket', 'connect_error detail', {
                message: detail.message,
                data: detail.data,
                description: detail.description,
                type: detail.type,
            });
        }
    });

    socket.on('addon:meta-bench-r1:job', async (job) => {
        runnerInfo('job', 'received', {
            phase: job?.phase,
            runId: job?.runId,
            botCount: job?.botCount,
            vcBotCount: job?.vcBotCount,
            worlds: job?.worlds,
            pdfPath: job?.pdfPath,
        });
        const started = Date.now();
        try {
            if (job.phase === 'socket-bots') {
                runnerInfo('job', 'socket-bots starting', { botCount: job.botCount, worlds: job.worlds });
                const metrics = await runSocketBotPool({
                    serverUrl: server,
                    benchToken: job.benchToken,
                    runId: job.runId,
                    botCount: job.botCount,
                    worlds: job.worlds,
                    durationMs: 120_000,
                });
                runnerInfo('job', 'socket-bots done', metrics);
                await postJson(
                    server,
                    `/api/addons/meta-bench-r1/runs/${job.runId}/metrics`,
                    { benchToken: job.benchToken, mvConnect: metrics },
                    job.benchToken,
                    'metrics-mv-connect'
                );
                runnerInfo('job', 'mv-connect metrics posted');
                socket.emit('addon:meta-bench-r1:progress', {
                    runId: job.runId,
                    phase: 'socket-bots',
                    percent: 100,
                });
            } else if (job.phase === 'audio-vc') {
                const worldId = (job.worlds && job.worlds[0]) || 'default';
                runnerInfo('job', 'audio-vc starting', {
                    vcBotCount: job.vcBotCount || 10,
                    worldId,
                    pdfPath: job.pdfPath,
                });
                const metrics = await runMediasoupBotPool({
                    serverUrl: server,
                    benchToken: job.benchToken,
                    runId: job.runId,
                    vcBotCount: job.vcBotCount || 10,
                    worlds: job.worlds,
                    pdfPath: job.pdfPath,
                    durationMs: 60_000,
                });
                runnerInfo('job', 'audio-vc done', metrics);
                await postJson(
                    server,
                    `/api/addons/meta-bench-r1/runs/${job.runId}/metrics`,
                    { benchToken: job.benchToken, audioVc: metrics },
                    job.benchToken,
                    'metrics-audio-vc'
                );
                runnerInfo('job', 'audio-vc metrics posted');
                socket.emit('addon:meta-bench-r1:progress', {
                    runId: job.runId,
                    phase: 'audio-vc',
                    percent: 100,
                });
            } else {
                runnerWarn('job', 'unknown phase', job?.phase);
            }
            runnerDebug('job', 'finished', { phase: job.phase, elapsedMs: Date.now() - started });
        } catch (e) {
            runnerError('job', `${job?.phase} failed`, formatError(e));
        }
    });

    process.on('SIGINT', () => {
        runnerInfo('main', 'shutting down (SIGINT)');
        clearInterval(heartbeatIv);
        socket.disconnect();
        process.exit(0);
    });
}

main().catch((e) => {
    runnerError('main', 'fatal', formatError(e));
    process.exit(1);
});
