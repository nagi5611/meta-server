#!/usr/bin/env node
// addons/meta-benchR1/runner/serve.js — Bench Runner CLI
import { io } from 'socket.io-client';
import { runSocketBotPool } from './socket-bot-pool.js';
import { runMediasoupBotPool } from './mediasoup-bot-pool.js';

/**
 * @param {string[]} argv
 */
function parseArgs(argv) {
    /** @type {Record<string, string>} */
    const out = {};
    for (let i = 2; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--server' && argv[i + 1]) out.server = argv[++i];
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
 */
async function postJson(base, path, body, auth) {
    const headers = { 'Content-Type': 'application/json' };
    if (auth) headers.Authorization = `Bearer ${auth}`;
    const res = await fetch(`${base}${path}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
    return json;
}

async function main() {
    const args = parseArgs(process.argv);
    const server = (args.server || 'http://localhost:3000').replace(/\/$/, '');
    const name = args.name || 'bench-runner';
    const maxBots = parseInt(args.maxBots || '50', 10);

    const registerBody = { name, recommendedMaxBots: maxBots };
    if (args.pairing) registerBody.pairingCode = args.pairing;
    else if (args.secret) registerBody.runnerSecret = args.secret;
    else {
        console.error('Usage: node serve.js --server URL (--secret SECRET | --pairing CODE) [--name NAME] [--max-bots N]');
        process.exit(1);
    }

    await postJson(server, '/api/addons/meta-benchR1/runner/register', registerBody);
    console.log('[runner] registered');

    const heartbeatIv = setInterval(() => {
        if (!args.secret) return;
        postJson(
            server,
            '/api/addons/meta-benchR1/runner/heartbeat',
            {},
            args.secret
        ).catch((e) => console.warn('[runner] heartbeat failed:', e.message));
    }, 25_000);

    const socket = io(server, {
        transports: ['websocket'],
        auth: args.secret ? { runnerSecret: args.secret } : {},
    });

    socket.on('connect', () => {
        console.log('[runner] socket connected', socket.id);
        if (args.secret) {
            socket.emit('addon:meta-benchR1:runner-attach', { runnerSecret: args.secret }, (ack) => {
                console.log('[runner] attach', ack);
            });
        }
    });

    socket.on('addon:meta-benchR1:job', async (job) => {
        console.log('[runner] job', job.phase, job.runId);
        try {
            if (job.phase === 'socket-bots') {
                const metrics = await runSocketBotPool({
                    serverUrl: server,
                    benchToken: job.benchToken,
                    botCount: job.botCount,
                    worlds: job.worlds,
                    durationMs: 90_000,
                });
                await postJson(
                    server,
                    `/api/addons/meta-benchR1/runs/${job.runId}/metrics`,
                    { benchToken: job.benchToken, mvConnect: metrics },
                    job.benchToken
                );
                socket.emit('addon:meta-benchR1:progress', {
                    runId: job.runId,
                    phase: 'socket-bots',
                    percent: 100,
                });
            } else if (job.phase === 'audio-vc') {
                const worldId = (job.worlds && job.worlds[0]) || 'default';
                const metrics = await runMediasoupBotPool({
                    serverUrl: server,
                    benchToken: job.benchToken,
                    vcBotCount: job.vcBotCount || 10,
                    worldId,
                    pdfPath: job.pdfPath,
                    durationMs: 60_000,
                });
                await postJson(
                    server,
                    `/api/addons/meta-benchR1/runs/${job.runId}/metrics`,
                    { benchToken: job.benchToken, audioVc: metrics },
                    job.benchToken
                );
                socket.emit('addon:meta-benchR1:progress', {
                    runId: job.runId,
                    phase: 'audio-vc',
                    percent: 100,
                });
            }
        } catch (e) {
            console.error('[runner] job failed:', e);
        }
    });

    process.on('SIGINT', () => {
        clearInterval(heartbeatIv);
        socket.disconnect();
        process.exit(0);
    });
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
