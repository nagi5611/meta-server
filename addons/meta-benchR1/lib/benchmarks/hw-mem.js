// addons/meta-benchR1/lib/benchmarks/hw-mem.js
import crypto from 'node:crypto';

const SIZE_BYTES = 512 * 1024 * 1024;

/**
 * @returns {Promise<{ readMbps: number, writeMbps: number, checksumOk: boolean, latencyMs: number }>}
 */
export async function runHwMemBenchmark() {
    const start = process.hrtime.bigint();
    const buf = Buffer.alloc(SIZE_BYTES);
    for (let i = 0; i < SIZE_BYTES; i += 4096) {
        buf[i] = i & 0xff;
    }
    const hashBefore = crypto.createHash('sha256').update(buf).digest('hex');

    const writeStart = process.hrtime.bigint();
    for (let pass = 0; pass < 2; pass++) {
        for (let i = 0; i < SIZE_BYTES; i += 64) {
            buf[i] = (buf[i] + 1) & 0xff;
        }
    }
    const writeNs = Number(process.hrtime.bigint() - writeStart);
    const writeMbps = (SIZE_BYTES * 2 * 8) / (writeNs / 1e9) / 1e6;

    const readStart = process.hrtime.bigint();
    let acc = 0;
    for (let i = 0; i < SIZE_BYTES; i += 4096) {
        acc += buf[i];
    }
    void acc;
    const readNs = Number(process.hrtime.bigint() - readStart);
    const readMbps = (SIZE_BYTES * 8) / (readNs / 1e9) / 1e6;

    const hashAfter = crypto.createHash('sha256').update(buf).digest('hex');
    const latencyMs = Number(process.hrtime.bigint() - start) / 1e6;

    return {
        readMbps,
        writeMbps,
        checksumOk: hashBefore !== hashAfter,
        latencyMs,
    };
}
