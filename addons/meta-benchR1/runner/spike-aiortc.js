#!/usr/bin/env node
// addons/meta-benchR1/runner/spike-aiortc.js — M4-0: VC join→produce→consume 1 本（FakeHandler フォールバック）
/**
 * 本番計測は mediasoup-client-aiortc が必須（Linux Runner 推奨）。
 * このスクリプトは FakeHandler でパイプライン検証用。
 *
 * Usage:
 *   node spike-aiortc.js --server http://localhost:3000 --bench-token TOKEN
 */
import { io } from 'socket.io-client';
import { MediasoupBenchClient } from './protocol.js';

function parseArgs(argv) {
    /** @type {Record<string, string>} */
    const out = {};
    for (let i = 2; i < argv.length; i++) {
        if (argv[i] === '--server' && argv[i + 1]) out.server = argv[++i];
        else if (argv[i] === '--bench-token' && argv[i + 1]) out.benchToken = argv[++i];
    }
    return out;
}

async function main() {
    const { server = 'http://localhost:3000', benchToken } = parseArgs(process.argv);
    if (!benchToken) {
        console.error('--bench-token required (管理画面で run 開始後に取得)');
        process.exit(1);
    }

    const socket = io(server.replace(/\/$/, ''), {
        transports: ['websocket'],
        auth: { benchToken },
    });
    await new Promise((resolve, reject) => {
        socket.once('connect', resolve);
        socket.once('connect_error', reject);
    });
    console.log('[spike] connected', socket.id);

    const client = new MediasoupBenchClient(socket, 'vc');
    await client.join({ roomId: 'default' });
    console.log('[spike] vc join + produce OK (FakeHandler)');

    await client.samplePacketLoss();
    console.log('[spike] stats sample loss%=', client.getMedianLossPct());

    await client.close();
    socket.disconnect();
    console.log('[spike] done — aiortc 本番は mediasoup-client-aiortc を別途検証すること');
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
