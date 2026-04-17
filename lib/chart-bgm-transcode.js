// lib/chart-bgm-transcode.js
// 譜面BGM用: アップロード済み MP3 を WAV (PCM) に変換し、ブラウザの decodeAudioData 負荷を下げる

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import ffmpegStatic from 'ffmpeg-static';

/**
 * MP3 パスに対応する WAV サイドカーのパスを返す
 * @param {string} mp3Path
 * @returns {string}
 */
export function wavPathForMp3(mp3Path) {
    const base = String(mp3Path || '').replace(/\.mp3$/i, '');
    return `${base}.wav`;
}

/**
 * ffmpeg で MP3 をステレオ 44.1kHz WAV に変換する
 * @param {string} mp3Path
 * @param {string} wavPath
 * @returns {Promise<void>}
 */
export function transcodeMp3FileToWav(mp3Path, wavPath) {
    const ffmpegPath = ffmpegStatic;
    if (!ffmpegPath || !fs.existsSync(ffmpegPath)) {
        return Promise.reject(new Error('ffmpeg binary not available (ffmpeg-static)'));
    }
    if (!fs.existsSync(mp3Path)) {
        return Promise.reject(new Error(`MP3 not found: ${mp3Path}`));
    }
    const dir = path.dirname(wavPath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    return new Promise((resolve, reject) => {
        const args = [
            '-hide_banner',
            '-loglevel', 'error',
            '-y',
            '-i', mp3Path,
            '-ac', '2',
            '-ar', '44100',
            wavPath,
        ];
        execFile(ffmpegPath, args, { maxBuffer: 20 * 1024 * 1024 }, (err, _stdout, stderr) => {
            if (err) {
                reject(new Error(stderr?.toString?.() || err.message || String(err)));
                return;
            }
            resolve();
        });
    });
}

/**
 * MP3 を書いた直後に呼ぶ: 対応 WAV を生成する
 * @param {string} mp3Path
 * @returns {Promise<boolean>} 成功したら true（失敗時は false、ログは呼び出し側）
 */
export async function ensureWavSidecarForMp3Path(mp3Path) {
    const wav = wavPathForMp3(mp3Path);
    try {
        await transcodeMp3FileToWav(mp3Path, wav);
        return true;
    } catch {
        return false;
    }
}

/**
 * chart-bgm ストレージ内の全 MP3 を走査し、無い・古い WAV を再生成する
 * @param {string} chartBgmDir
 * @returns {Promise<{ ok: number, fail: number, skip: number }>}
 */
export async function runChartBgmWavMigration(chartBgmDir) {
    const ffmpegPath = ffmpegStatic;
    if (!ffmpegPath || !fs.existsSync(ffmpegPath)) {
        console.warn('[chart-bgm] ffmpeg-static binary missing; skip WAV migration');
        return { ok: 0, fail: 0, skip: 0 };
    }
    if (!chartBgmDir || !fs.existsSync(chartBgmDir)) {
        return { ok: 0, fail: 0, skip: 0 };
    }

    /** @param {string} dir */
    const walkMp3 = (dir) => {
        /** @type {string[]} */
        const out = [];
        let names;
        try {
            names = fs.readdirSync(dir);
        } catch {
            return out;
        }
        for (const name of names) {
            const full = path.join(dir, name);
            let st;
            try {
                st = fs.statSync(full);
            } catch {
                continue;
            }
            if (st.isDirectory()) {
                out.push(...walkMp3(full));
            } else if (name.toLowerCase().endsWith('.mp3')) {
                out.push(full);
            }
        }
        return out;
    };

    const mp3List = walkMp3(chartBgmDir);
    let ok = 0;
    let fail = 0;
    let skip = 0;

    for (const mp3Path of mp3List) {
        const wavPath = wavPathForMp3(mp3Path);
        let need = false;
        if (!fs.existsSync(wavPath)) {
            need = true;
        } else {
            try {
                const mMp3 = fs.statSync(mp3Path).mtimeMs;
                const mWav = fs.statSync(wavPath).mtimeMs;
                if (mMp3 > mWav) need = true;
            } catch {
                need = true;
            }
        }
        if (!need) {
            skip++;
            continue;
        }
        try {
            await transcodeMp3FileToWav(mp3Path, wavPath);
            ok++;
            console.log(`[chart-bgm] WAV sidecar: ${path.relative(chartBgmDir, wavPath)}`);
        } catch (e) {
            fail++;
            console.warn(`[chart-bgm] WAV transcode failed for ${mp3Path}:`, e?.message || e);
        }
    }

    if (ok + fail > 0) {
        console.log(`[chart-bgm] WAV migration done: ok=${ok} fail=${fail} skip=${skip}`);
    }
    return { ok, fail, skip };
}
