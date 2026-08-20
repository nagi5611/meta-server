// public/js/caption-worklet.js — マイク音声を 16kHz mono 16bit LE PCM にダウンサンプルして
// ~100ms 分ずつメインスレッドへ postMessage する AudioWorkletProcessor。
// STT（Speech-to-Text）へ送る PCM を生成するためのもの。VAD/送信ゲートはメインスレッド側で行う。
class CaptionDownsampler extends AudioWorkletProcessor {
    constructor() {
        super();
        this.targetRate = 16000;
        // 入力(sampleRate=通常48000) から 16000 への変換比（入力サンプル/出力サンプル）
        this.ratio = sampleRate / this.targetRate;
        this.inBuf = new Float32Array(0);
        this.readPos = 0;
        this.out = [];
        // 100ms 分（16000 * 0.1 = 1600 サンプル）ためて送る
        this.frameSamples = Math.round(this.targetRate * 0.1);
    }

    _appendInput(ch) {
        const merged = new Float32Array(this.inBuf.length + ch.length);
        merged.set(this.inBuf, 0);
        merged.set(ch, this.inBuf.length);
        this.inBuf = merged;
    }

    _flush() {
        const n = this.out.length;
        if (n === 0) return;
        const pcm = new Int16Array(n);
        for (let i = 0; i < n; i++) {
            let v = this.out[i];
            if (v > 1) v = 1; else if (v < -1) v = -1;
            pcm[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
        }
        this.out = [];
        // ArrayBuffer を transfer してコピーを避ける
        this.port.postMessage(pcm.buffer, [pcm.buffer]);
    }

    process(inputs) {
        const input = inputs[0];
        if (!input || input.length === 0) return true;
        const ch = input[0];
        if (!ch || ch.length === 0) return true;

        this._appendInput(ch);

        // 線形補間でダウンサンプル
        while (true) {
            const i0 = Math.floor(this.readPos);
            const i1 = i0 + 1;
            if (i1 >= this.inBuf.length) break;
            const frac = this.readPos - i0;
            const s = this.inBuf[i0] * (1 - frac) + this.inBuf[i1] * frac;
            this.out.push(s);
            this.readPos += this.ratio;
            if (this.out.length >= this.frameSamples) this._flush();
        }

        // 消費済み入力を破棄
        const consumed = Math.floor(this.readPos);
        if (consumed > 0) {
            this.inBuf = this.inBuf.slice(consumed);
            this.readPos -= consumed;
        }
        return true;
    }
}

registerProcessor('caption-downsampler', CaptionDownsampler);
