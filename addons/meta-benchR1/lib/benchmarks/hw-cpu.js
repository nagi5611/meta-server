// addons/meta-benchR1/lib/benchmarks/hw-cpu.js
import os from 'node:os';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);

/**
 * @param {number} n
 * @returns {boolean}
 */
function isPrime(n) {
    if (n < 2) return false;
    if (n % 2 === 0) return n === 2;
    for (let i = 3; i * i <= n; i += 2) {
        if (n % i === 0) return false;
    }
    return true;
}

if (!isMainThread) {
    const iterations = workerData?.iterations ?? 50000;
    let count = 0;
    for (let i = 2; i < iterations; i++) {
        if (isPrime(i)) count++;
    }
    parentPort?.postMessage({ count });
}

/**
 * @param {number} [durationMs]
 * @returns {Promise<{ opsPerSec: number, workers: number }>}
 */
export async function runHwCpuBenchmark(durationMs = 30_000) {
    const workers = Math.max(1, os.availableParallelism?.() ?? os.cpus().length);
    const endAt = Date.now() + durationMs;
    let totalOps = 0;

    while (Date.now() < endAt) {
        const batch = await Promise.all(
            Array.from({ length: workers }, () => {
                return new Promise((resolve, reject) => {
                    const w = new Worker(__filename, {
                        workerData: { iterations: 40000 + Math.floor(Math.random() * 5000) },
                    });
                    w.on('message', (msg) => {
                        resolve(msg.count || 0);
                        w.terminate().catch(() => {});
                    });
                    w.on('error', reject);
                });
            })
        );
        totalOps += batch.reduce((a, b) => a + b, 0);
    }

    const elapsedSec = durationMs / 1000;
    return { opsPerSec: totalOps / elapsedSec, workers };
}
