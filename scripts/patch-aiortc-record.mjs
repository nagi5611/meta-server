#!/usr/bin/env node
// scripts/patch-aiortc-record.mjs — mediasoup-client-aiortc に受信トラック録音 API を追加
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkgDir = path.join(root, 'node_modules', 'mediasoup-client-aiortc');
const workerPy = path.join(pkgDir, 'worker', 'worker.py');
const workerJs = path.join(pkgDir, 'lib', 'Worker.js');

if (!fs.existsSync(workerPy) || !fs.existsSync(workerJs)) {
    console.warn('[patch-aiortc-record] mediasoup-client-aiortc not installed — skip');
    process.exit(0);
}

const pyMarker = 'elif request.method == "recordRecvTrack":';
let py = fs.readFileSync(workerPy, 'utf8');
if (!py.includes(pyMarker)) {
    const insertAfter = '        elif request.method == "createPlayer":';
    const idx = py.indexOf(insertAfter);
    if (idx < 0) {
        console.error('[patch-aiortc-record] worker.py layout unexpected');
        process.exit(1);
    }
    const snippet = `        elif request.method == "recordRecvTrack":
            from aiortc.contrib.media import MediaRecorder
            data = request.data
            track_id = data["trackId"]
            file_path = data["file"]
            duration_sec = float(data.get("durationSec", 30))
            track = recvTracks.get(track_id)
            if not track:
                raise Exception(f"recv track not found: {track_id}")
            recorder = MediaRecorder(file_path, format="wav")
            recorder.addTrack(track)
            await recorder.start()
            await asyncio.sleep(duration_sec)
            await recorder.stop()
            return {"file": file_path, "durationSec": duration_sec}

`;
    py = py.slice(0, idx) + snippet + py.slice(idx);
    fs.writeFileSync(workerPy, py);
    console.log('[patch-aiortc-record] patched worker.py');
} else {
    console.log('[patch-aiortc-record] worker.py already patched');
}

const jsMarker = 'async recordRecvTrack(';
let js = fs.readFileSync(workerJs, 'utf8');
if (!js.includes(jsMarker)) {
    const anchor = '    /**\n     * Create a mediasoup-client HandlerFactory.\n     */';
    const idx = js.indexOf(anchor);
    if (idx < 0) {
        console.error('[patch-aiortc-record] Worker.js layout unexpected');
        process.exit(1);
    }
    const snippet = `    /**
     * Record a received remote track to a WAV file (bench extension).
     */
    async recordRecvTrack(trackId, file, durationSec = 30) {
        return this.#channel.request('recordRecvTrack', {}, { trackId, file, durationSec });
    }
    `;
    js = js.slice(0, idx) + snippet + js.slice(idx);
    fs.writeFileSync(workerJs, js);
    console.log('[patch-aiortc-record] patched Worker.js');
} else {
    console.log('[patch-aiortc-record] Worker.js already patched');
}
