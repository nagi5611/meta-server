// lib/speech-captions.js — Google Cloud Speech-to-Text ストリーミングのラッパ
// - createCaptionSession(): 話者1人ぶんのストリーミング認識セッションを作る
// - Google の 1 ストリーミングは ~5 分上限のため ~4 分ごとに内部ストリームを張り直す
// - provider='mock' 時は資格情報不要のスタブ（無音判定で擬似 interim/final を返す）
import {
    CAPTIONS_STT_PROVIDER,
    CAPTIONS_LANGUAGE_CODE,
    CAPTIONS_MODEL,
    resolveSpeechCredentials,
} from './captions-config.js';

const SAMPLE_RATE = 16000;
/** Google streaming の上限(~305s)より手前で張り直す */
const RESTART_INTERVAL_MS = 240000;

let SpeechClientCtor = null;
let sharedGoogleClient = null;

/**
 * @google-cloud/speech の SpeechClient を遅延生成（mock/テストでは import しない）
 * @returns {Promise<object>}
 */
async function getGoogleClient() {
    if (!SpeechClientCtor) {
        const mod = await import('@google-cloud/speech');
        SpeechClientCtor = mod.SpeechClient || mod.default?.SpeechClient || mod.v1?.SpeechClient;
        if (!SpeechClientCtor) throw new Error('[captions] SpeechClient not found in @google-cloud/speech');
    }
    if (!sharedGoogleClient) {
        const creds = resolveSpeechCredentials();
        if (creds && creds.mode === 'inline') {
            sharedGoogleClient = new SpeechClientCtor({
                credentials: creds.credentials,
                projectId: creds.projectId,
            });
        } else {
            // ADC: GOOGLE_APPLICATION_CREDENTIALS を SDK が自動参照
            sharedGoogleClient = new SpeechClientCtor();
        }
    }
    return sharedGoogleClient;
}

/**
 * 16bit LE PCM の RMS（0..1）を返す（mock の簡易 VAD 用）
 * @param {Buffer} buf
 * @returns {number}
 */
function pcm16Rms(buf) {
    if (!buf || buf.length < 2) return 0;
    const n = Math.floor(buf.length / 2);
    let sumSq = 0;
    for (let i = 0; i < n; i++) {
        const s = buf.readInt16LE(i * 2) / 32768;
        sumSq += s * s;
    }
    return Math.sqrt(sumSq / n);
}

/**
 * gRPC ストリームが write 可能か
 * @param {import('stream').Duplex | null | undefined} stream
 * @returns {boolean}
 */
export function isCaptionStreamWritable(stream) {
    if (!stream) return false;
    if (stream.destroyed) return false;
    if (typeof stream.writable === 'boolean' && !stream.writable) return false;
    return true;
}

/**
 * Google ストリーミング認識セッション
 */
class GoogleCaptionSession {
    constructor({ languageCode, model, onInterim, onFinal, onError }) {
        this.languageCode = languageCode || CAPTIONS_LANGUAGE_CODE;
        this.model = model || CAPTIONS_MODEL || undefined;
        this.onInterim = onInterim || (() => {});
        this.onFinal = onFinal || (() => {});
        this.onError = onError || (() => {});
        this.stream = null;
        this.restartTimer = null;
        this.recoverTimer = null;
        this.closed = false;
        this.isMock = false;
        /** 定期張り直しや close による意図的な end 中 */
        this._intentionalClose = false;
    }

    async start() {
        const client = await getGoogleClient();
        this.client = client;
        this._openStream();
    }

    _detachStream(stream) {
        if (this.stream === stream) {
            this.stream = null;
        }
        if (!stream) return;
        try {
            stream.removeAllListeners('data');
            stream.removeAllListeners('error');
            stream.removeAllListeners('close');
        } catch (_) {
            /* ignore */
        }
    }

    _handleStreamFailure(stream, err) {
        this._detachStream(stream);
        if (this.closed || this._intentionalClose) return;
        if (err) this.onError(err);
        this._scheduleRecover();
    }

    _scheduleRecover() {
        if (this.closed || this.recoverTimer) return;
        this.recoverTimer = setTimeout(() => {
            this.recoverTimer = null;
            if (this.closed || this.stream) return;
            try {
                this._openStream();
            } catch (e) {
                this.onError(e);
            }
        }, 500);
        if (this.recoverTimer.unref) this.recoverTimer.unref();
    }

    _openStream() {
        if (this.closed) return;
        if (this.recoverTimer) {
            clearTimeout(this.recoverTimer);
            this.recoverTimer = null;
        }
        const streamingConfig = {
            config: {
                encoding: 'LINEAR16',
                sampleRateHertz: SAMPLE_RATE,
                languageCode: this.languageCode,
                enableAutomaticPunctuation: true,
                ...(this.model ? { model: this.model } : {}),
            },
            interimResults: true,
        };
        const stream = this.client.streamingRecognize(streamingConfig);
        stream.on('data', (data) => {
            const result = data && data.results && data.results[0];
            if (!result) return;
            const alt = result.alternatives && result.alternatives[0];
            const transcript = alt ? String(alt.transcript || '') : '';
            if (!transcript) return;
            if (result.isFinal) this.onFinal(transcript);
            else this.onInterim(transcript);
        });
        stream.on('error', (err) => {
            this._handleStreamFailure(stream, err);
        });
        stream.on('close', () => {
            if (this.stream === stream) {
                this.stream = null;
            }
            if (!this.closed && !this._intentionalClose && !this.stream) {
                this._scheduleRecover();
            }
        });
        this.stream = stream;
        this._scheduleRestart();
    }

    _scheduleRestart() {
        if (this.restartTimer) clearTimeout(this.restartTimer);
        this.restartTimer = setTimeout(() => {
            if (this.closed) return;
            const old = this.stream;
            this._intentionalClose = true;
            this.stream = null;
            try {
                if (old) old.end();
            } catch (_) {
                /* ignore */
            }
            this._intentionalClose = false;
            this._openStream();
        }, RESTART_INTERVAL_MS);
        if (this.restartTimer.unref) this.restartTimer.unref();
    }

    /** @param {Buffer} pcmChunk 16kHz mono 16bit LE */
    write(pcmChunk) {
        if (this.closed) return;
        if (!isCaptionStreamWritable(this.stream)) return;
        try {
            // @google-cloud/speech の streamingRecognize は生 PCM Buffer を受け取り、
            // 内部で { audioContent } にラップする。オブジェクトを渡すと二重ラップで Malordered になる。
            this.stream.write(pcmChunk);
        } catch (err) {
            this._handleStreamFailure(this.stream, err);
        }
    }

    close() {
        this.closed = true;
        if (this.restartTimer) {
            clearTimeout(this.restartTimer);
            this.restartTimer = null;
        }
        if (this.recoverTimer) {
            clearTimeout(this.recoverTimer);
            this.recoverTimer = null;
        }
        this._intentionalClose = true;
        const old = this.stream;
        this.stream = null;
        try {
            if (old) old.end();
        } catch (_) {
            /* ignore */
        }
        this._intentionalClose = false;
    }
}

/**
 * 資格情報不要のモックセッション（パイプライン検証用）
 * 無音/発話を RMS で判定し、発話中は擬似 interim、発話終了で final を返す。
 */
class MockCaptionSession {
    constructor({ onInterim, onFinal }) {
        this.onInterim = onInterim || (() => {});
        this.onFinal = onFinal || (() => {});
        this.closed = false;
        this.isMock = true;
        this.speaking = false;
        this.speechStartAt = 0;
        this.lastSpeechAt = 0;
        this.rmsThreshold = 0.02;
        this.tick = setInterval(() => this._evaluate(), 300);
        if (this.tick.unref) this.tick.unref();
    }

    _evaluate() {
        if (this.closed) return;
        const now = Date.now();
        if (this.speaking) {
            if (now - this.lastSpeechAt > 800) {
                // 発話終了 → final
                const secs = Math.max(1, Math.round((this.lastSpeechAt - this.speechStartAt) / 1000));
                this.onFinal(`[mock] 音声 ${secs}s`);
                this.speaking = false;
            } else {
                const secs = ((now - this.speechStartAt) / 1000).toFixed(1);
                this.onInterim(`（認識中… ${secs}s）`);
            }
        }
    }

    write(pcmChunk) {
        if (this.closed) return;
        const rms = pcm16Rms(pcmChunk);
        if (rms >= this.rmsThreshold) {
            const now = Date.now();
            if (!this.speaking) { this.speaking = true; this.speechStartAt = now; }
            this.lastSpeechAt = now;
        }
    }

    close() {
        this.closed = true;
        if (this.tick) { clearInterval(this.tick); this.tick = null; }
        if (this.speaking) {
            const secs = Math.max(1, Math.round((this.lastSpeechAt - this.speechStartAt) / 1000));
            this.onFinal(`[mock] 音声 ${secs}s`);
            this.speaking = false;
        }
    }
}

/**
 * 話者1人ぶんの字幕セッションを作る。
 * @param {{provider?:string, languageCode?:string, model?:string,
 *          onInterim?:(t:string)=>void, onFinal?:(t:string)=>void, onError?:(e:Error)=>void}} opts
 * @returns {Promise<{write:(b:Buffer)=>void, close:()=>void, isMock:boolean}>}
 */
export async function createCaptionSession(opts = {}) {
    const provider = (opts.provider || CAPTIONS_STT_PROVIDER || 'google').toLowerCase();
    if (provider === 'mock') {
        return new MockCaptionSession(opts);
    }
    const session = new GoogleCaptionSession(opts);
    await session.start();
    return session;
}

export const SPEECH_SAMPLE_RATE = SAMPLE_RATE;
