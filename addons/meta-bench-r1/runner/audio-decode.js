// addons/meta-bench-r1/runner/audio-decode.js — ffmpeg でモノラル 48kHz PCM へデコード
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import ffmpegStatic from 'ffmpeg-static';

const SAMPLE_RATE = 48_000;

/**
 * 音声ファイルをモノラル 48kHz Float32 PCM にデコードする
 * @param {string} filePath
 * @returns {Promise<Float32Array>}
 */
export function decodeAudioToMono48k(filePath) {
    const ffmpegPath = ffmpegStatic;
    if (!ffmpegPath || !fs.existsSync(ffmpegPath)) {
        return Promise.reject(new Error('ffmpeg binary not available (ffmpeg-static)'));
    }
    if (!fs.existsSync(filePath)) {
        return Promise.reject(new Error(`audio file not found: ${filePath}`));
    }

    return new Promise((resolve, reject) => {
        const args = [
            '-hide_banner',
            '-loglevel',
            'error',
            '-i',
            filePath,
            '-ac',
            '1',
            '-ar',
            String(SAMPLE_RATE),
            '-f',
            'f32le',
            'pipe:1',
        ];
        execFile(ffmpegPath, args, { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
            if (err) {
                reject(new Error(stderr?.toString?.() || err.message || String(err)));
                return;
            }
            const buf = /** @type {Buffer} */ (stdout);
            if (!buf.length) {
                reject(new Error(`empty PCM from ${filePath}`));
                return;
            }
            resolve(new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4));
        });
    });
}

export { SAMPLE_RATE };
