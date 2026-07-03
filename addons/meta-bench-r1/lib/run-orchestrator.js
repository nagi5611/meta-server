// addons/meta-bench-r1/lib/run-orchestrator.js — run ライフサイクル
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import process from 'node:process';
import crypto from 'node:crypto';
import {
    setBenchMaintenance,
    signBenchToken,
    isBenchMaintenance,
    BENCH_TOKEN_DEFAULT_TTL_MS,
} from '../../../lib/bench-maintenance.js';
import {
    startTickSampling,
    stopTickSampling,
    getTickMetricsSnapshot,
    getTheoreticalMaxTps,
    diagnoseTickMetrics,
} from '../../../lib/bench-tick-metrics.js';
import { getAddonCatalogSnapshot } from '../../../lib/plugin-bootstrap.js';
import { createBenchUsers, deleteBenchUsers } from '../../../db/users.js';
import { runPreflightChecks } from './preflight.js';
import { runHwCpuBenchmark } from './benchmarks/hw-cpu.js';
import { runHwMemBenchmark } from './benchmarks/hw-mem.js';
import { runDbSqliteBenchmark } from './benchmarks/db-sqlite.js';
import {
    scoreMvTps,
    scoreDbLatency,
    scoreMvDegrade,
    scoreCpuDegrade,
    scorePingP95,
    scoreMvConnect,
    scorePacketLoss,
    overallScore,
    clampScore,
} from './scoring.js';
import { buildBenchReportHtml, benchReportFilename } from './report-html.js';
import { getRunnerStatusByName, buildRunnerReportInfo } from './runner-registry.js';
import {
    normalizeBenchPhases,
    isBenchPhaseEnabled,
    scoreKeysForPhases,
    BENCH_PHASE_DEFS,
} from './bench-phases.js';

const RUN_TIMEOUT_MS = 6 * 60 * 1000;
const PHASE_MS = {
    hw: 45_000,
    socketBots: 120_000,
    db: 60_000,
    audioVc: 120_000,
};

/** @type {import('socket.io').Server | null} */
let ioRef = null;
/** @type {string} */
let reportsDir = '';
/** @type {string} */
let addonDbPath = '';
/** @type {number} */
let hwCpuCalibration = 0;
/** @type {{ user: number, system: number } | null} */
let cpuBaseline = null;
/** @type {ReturnType<typeof setInterval> | null} */
let cpuBaselineTimer = null;

/** @type {Map<string, { abort: boolean, benchToken: string }>} */
const activeRuns = new Map();

/**
 * @param {object} opts
 */
export function initRunOrchestrator(opts) {
    if (opts.io) ioRef = opts.io;
    if (opts.reportsDir) reportsDir = opts.reportsDir;
    if (opts.addonDbPath) addonDbPath = opts.addonDbPath;
    if (opts.hwCpuCalibration != null) hwCpuCalibration = opts.hwCpuCalibration || 0;
    if (!cpuBaselineTimer) startCpuBaselineSampling();
}

function startCpuBaselineSampling() {
    if (cpuBaselineTimer) return;
    cpuBaseline = process.cpuUsage();
    cpuBaselineTimer = setInterval(() => {
        cpuBaseline = process.cpuUsage();
    }, 1000);
}

/**
 * @param {import('better-sqlite3').Database} db
 */
function getActiveRunRow(db) {
    return db
        .prepare(`SELECT id FROM bench_runs WHERE status IN ('running', 'preflight') LIMIT 1`)
        .get();
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} runId
 */
function getRunRow(db, runId) {
    return db.prepare(`SELECT * FROM bench_runs WHERE id = ?`).get(runId);
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} runId
 * @param {object} patch
 */
function patchRun(db, runId, patch) {
    const fields = [];
    const vals = [];
    for (const [k, v] of Object.entries(patch)) {
        fields.push(`${k} = ?`);
        vals.push(v);
    }
    vals.push(runId);
    db.prepare(`UPDATE bench_runs SET ${fields.join(', ')} WHERE id = ?`).run(...vals);
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {number} botCount
 * @param {{ runnerName?: string, phases?: string[] }} [extra]
 */
export function evaluatePreflight(db, botCount, extra = {}) {
    const hasActive = !!getActiveRunRow(db);
    return runPreflightChecks({
        db,
        reportsDir,
        botCount,
        hasActiveRun: hasActive,
        runnerName: extra.runnerName,
        phases: extra.phases,
    });
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{ botCount: number, worlds: string[], pdfPath: string, config: Record<string, unknown>, runnerName?: string, phases?: string[] }} opts
 */
export async function startRun(db, opts) {
    const botCount = opts.botCount;
    const phases = normalizeBenchPhases(opts.phases);
    const runnerName = typeof opts.runnerName === 'string' ? opts.runnerName.trim() : '';
    const pre = evaluatePreflight(db, botCount, { runnerName, phases });
    if (!pre.ok) {
        const err = new Error(pre.failures.join('\n'));
        err.failures = pre.failures;
        throw err;
    }

    const runId = crypto.randomBytes(8).toString('hex');
    const benchToken = signBenchToken(runId, BENCH_TOKEN_DEFAULT_TTL_MS);
    const now = Date.now();

    db.prepare(
        `INSERT INTO bench_runs (id, status, phase, bot_count, started_at, created_at) VALUES (?, 'running', 'preflight', ?, ?, ?)`
    ).run(runId, botCount, now, now);

    const runControl = { abort: false, benchToken };
    activeRuns.set(runId, runControl);

    executeRun(db, runId, { ...opts, phases, runnerName }, runControl).catch((e) => {
        console.error('[meta-bench-r1] run error:', e);
    });

    return { runId, benchToken, phases, runnerName };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} runId
 */
export function abortRun(db, runId) {
    const ctrl = activeRuns.get(runId);
    if (ctrl) ctrl.abort = true;
    patchRun(db, runId, { status: 'failed', phase: 'aborted', finished_at: Date.now() });
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} runId
 */
export function getRunPublic(db, runId) {
    const row = getRunRow(db, runId);
    if (!row) return null;
    return rowToPublicRun(row, { includeMetrics: true });
}

/**
 * 管理画面用: 過去ベンチ run の一覧（新しい順）
 * @param {import('better-sqlite3').Database} db
 * @param {number} [limit]
 */
export function listRunsPublic(db, limit = 30) {
    const n = Math.max(1, Math.min(100, Number(limit) || 30));
    const rows = db
        .prepare(
            `SELECT id, status, phase, bot_count, scores_json, metrics_json, report_filename, error_message, started_at, finished_at, created_at
             FROM bench_runs
             ORDER BY COALESCE(started_at, created_at) DESC
             LIMIT ?`
        )
        .all(n);
    return rows.map((row) => rowToPublicRun(row, { includeMetrics: false }));
}

/**
 * @param {Record<string, unknown>} row
 * @param {{ includeMetrics?: boolean }} [opts]
 */
function rowToPublicRun(row, opts = {}) {
    const scores = row.scores_json ? JSON.parse(String(row.scores_json)) : null;
    const run = {
        id: row.id,
        status: row.status,
        phase: row.phase,
        botCount: row.bot_count,
        scores,
        overallScore: scores ? overallScore(scores) : null,
        reportFilename: row.report_filename,
        errorMessage: row.error_message,
        startedAt: row.started_at,
        finishedAt: row.finished_at,
        createdAt: row.created_at,
    };
    if (opts.includeMetrics !== false && row.metrics_json) {
        run.metrics = JSON.parse(String(row.metrics_json));
    }
    return run;
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} runId
 * @param {object} metrics
 */
export function ingestRunnerMetrics(db, runId, metrics) {
    const row = getRunRow(db, runId);
    if (!row) return false;
    const prev = row.metrics_json ? JSON.parse(row.metrics_json) : {};
    const merged = { ...prev, ...metrics, updatedAt: Date.now() };
    patchRun(db, runId, { metrics_json: JSON.stringify(merged) });
    return true;
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} runId
 * @param {object} opts
 * @param {{ abort: boolean, benchToken: string }} ctrl
 */
async function executeRun(db, runId, opts, ctrl) {
    const timeout = setTimeout(() => {
        ctrl.abort = true;
    }, RUN_TIMEOUT_MS);

    const phases = normalizeBenchPhases(opts.phases);
    const runnerName = opts.runnerName;
    const needsRunner = isBenchPhaseEnabled(phases, 'socket-bots') || isBenchPhaseEnabled(phases, 'audio-vc');
    const needsBenchUsers = isBenchPhaseEnabled(phases, 'socket-bots');
    const needsTick = isBenchPhaseEnabled(phases, 'socket-bots');

    /** @type {Record<string, number | null>} */
    const scores = {};
    /** @type {string[]} */
    const failures = [];
    /** @type {string[]} */
    const notes = [];
    let status = 'completed';
    const startedAt = Date.now();
    const metrics = {
        runnerName,
        phases,
        phaseLabels: BENCH_PHASE_DEFS.filter((p) => phases.includes(p.id)).map((p) => p.label),
        runner: buildRunnerReportInfo(runnerName),
    };

    let cpuBefore = null;
    let cpuRatio = 0;

    try {
        console.log('[meta-bench-r1] executeRun start', {
            runId,
            phases,
            needsRunner,
            needsTick,
            needsBenchUsers,
            runnerName,
            ioRef: !!ioRef,
            pid: process.pid,
        });

        if (needsRunner || needsTick) {
            setBenchMaintenance({ active: true, runId, io: ioRef });
        }
        if (needsTick) {
            startTickSampling(runId);
        }
        patchRun(db, runId, { phase: 'maintenance-on' });

        if (needsBenchUsers) {
            createBenchUsers(runId, opts.botCount);
        }

        /** @type {Promise<void>[]} */
        const parallelWaits = [];

        if (isBenchPhaseEnabled(phases, 'socket-bots')) {
            dispatchRunnerJob(
                runId,
                ctrl.benchToken,
                {
                    phase: 'socket-bots',
                    botCount: opts.botCount,
                    worlds: opts.worlds,
                    pdfPath: opts.pdfPath,
                },
                runnerName
            );
            cpuBefore = process.cpuUsage(cpuBaseline || undefined);
            patchRun(db, runId, { phase: 'socket-bots' });
            parallelWaits.push(
                sleep(PHASE_MS.socketBots).then(() => {
                    const tickSnap = getTickMetricsSnapshot();
                    metrics.tick = tickSnap;
                    scores['mv-tps'] = scoreMvTps(tickSnap.avgTickPerSec, getTheoreticalMaxTps());
                    console.log('[meta-bench-r1] socket-bots tick snapshot', {
                        runId,
                        avgTickPerSec: tickSnap.avgTickPerSec,
                        minTickPerSec: tickSnap.minTickPerSec,
                        byRoom: tickSnap.byRoom,
                        debug: tickSnap.debug,
                        diagnosis: tickSnap.diagnosis,
                        pid: process.pid,
                    });
                    if (tickSnap.avgTickPerSec <= 0) {
                        const dbg = tickSnap.debug || {};
                        const diagnosis =
                            tickSnap.diagnosis ||
                            diagnoseTickMetrics(dbg, tickSnap.byRoom || {});
                        failures.push(
                            `TPS 計測データなし: ${diagnosis} ` +
                                `(hookCalls=${dbg.totalHookCalls ?? 0}, recorded=${dbg.totalRecordedEmits ?? 0}, ` +
                                `skipped=${dbg.skippedNotSampling ?? 0}, sampling=${dbg.sampling}, ` +
                                `hookInstalled=${dbg.hookInstalled}, pid=${dbg.pid ?? process.pid})`
                        );
                        notes.push(`TPS診断: ${diagnosis}`);
                        if (status === 'completed') status = 'partial';
                    }
                    if (cpuBefore) {
                        const cpuDuring = process.cpuUsage(cpuBefore);
                        cpuRatio =
                            (cpuDuring.user + cpuDuring.system) /
                            Math.max(1, PHASE_MS.socketBots * 1000 * os.cpus().length);
                    }
                })
            );
        }

        if (isBenchPhaseEnabled(phases, 'hw')) {
            patchRun(db, runId, { phase: 'hw-cpu-mem' });
            if (!cpuBefore) cpuBefore = process.cpuUsage(cpuBaseline || undefined);
            parallelWaits.push(
                Promise.all([runHwCpuBenchmark(PHASE_MS.hw), runHwMemBenchmark()]).then(
                    ([cpuResult, memResult]) => {
                        metrics.hwCpu = cpuResult;
                        metrics.hwMem = memResult;
                        scores['hw-cpu'] = scoreHwCpu(cpuResult.opsPerSec);
                        scores['hw-mem'] = scoreHwMem(memResult);
                        if (!isBenchPhaseEnabled(phases, 'socket-bots') && cpuBefore) {
                            const cpuDuring = process.cpuUsage(cpuBefore);
                            cpuRatio =
                                (cpuDuring.user + cpuDuring.system) /
                                Math.max(1, PHASE_MS.hw * 1000 * os.cpus().length);
                        }
                    }
                )
            );
        }

        if (parallelWaits.length) {
            await Promise.all(parallelWaits);
            if (ctrl.abort) throw new Error('aborted');
        }

        if (isBenchPhaseEnabled(phases, 'db-sqlite')) {
            patchRun(db, runId, { phase: 'db-sqlite' });
            const dbResult = runDbSqliteBenchmark(addonDbPath);
            metrics.dbSqlite = dbResult;
            scores['db-sqlite'] = scoreDbLatency(dbResult.maxLatencyMs);
        }

        if (isBenchPhaseEnabled(phases, 'audio-vc')) {
            patchRun(db, runId, { phase: 'audio-vc' });
            dispatchRunnerJob(runId, ctrl.benchToken, {
                phase: 'audio-vc',
                botCount: opts.botCount,
                vcBotCount: 10,
                worlds: opts.worlds,
                pdfPath: opts.pdfPath,
            }, runnerName);
            await sleep(PHASE_MS.audioVc);
        }

        const row = getRunRow(db, runId);
        const runnerMetrics = row?.metrics_json ? JSON.parse(row.metrics_json) : {};
        Object.assign(metrics, runnerMetrics);

        if (isBenchPhaseEnabled(phases, 'socket-bots')) {
            if (runnerMetrics.mvConnect) {
                scores['mv-connect'] = scoreMvConnect(
                    runnerMetrics.mvConnect.retainPct ?? 0,
                    runnerMetrics.mvConnect.pingP95Ms ?? 300
                );
            } else {
                scores['mv-connect'] = 0;
                failures.push('Runner から mv-connect メトリクスが届きませんでした。');
                status = 'partial';
            }

            const cpuScore = scoreCpuDegrade(cpuRatio);
            const pingScore = scorePingP95(runnerMetrics.mvConnect?.pingP95Ms ?? 300);
            scores['mv-degrade'] = scoreMvDegrade({
                tpsScore: scores['mv-tps'] ?? 0,
                cpuScore,
                pingScore,
            });
        }

        if (isBenchPhaseEnabled(phases, 'audio-vc')) {
            if (runnerMetrics.audioVc) {
                scores['audio-vc'] = scoreAudioVc(runnerMetrics.audioVc);
            } else {
                scores['audio-vc'] = 0;
                failures.push('Runner から audio-vc メトリクスが届きませんでした。');
                status = 'partial';
            }
        }

        if (ctrl.abort) {
            status = 'failed';
            failures.push('タイムアウトまたは手動中止。');
        }
    } catch (e) {
        status = 'failed';
        failures.push(e instanceof Error ? e.message : String(e));
        patchRun(db, runId, { error_message: failures.join('; ') });
    } finally {
        clearTimeout(timeout);
        if (needsTick) stopTickSampling();
        if (needsRunner || needsTick) setBenchMaintenance({ active: false, runId: null, io: ioRef });

        if (needsBenchUsers) {
            let deleteFailed = false;
            for (let i = 0; i < 3; i++) {
                try {
                    deleteBenchUsers(runId);
                    deleteFailed = false;
                    break;
                } catch {
                    deleteFailed = true;
                }
            }
            if (deleteFailed) {
                failures.push(`一時ユーザー削除失敗（要手動削除）: runId=${runId}`);
                notes.push(`bench_users WHERE run_id='${runId}'`);
            }
        }

        const catalog = getAddonCatalogSnapshot();
        const runnerInfo = buildRunnerReportInfo(runnerName) || (runnerName ? { name: runnerName } : null);
        if (runnerInfo) {
            const rawAv = runnerMetrics.audioVc?.raw;
            if (rawAv?.handlerMode) runnerInfo.mediasoupMode = rawAv.handlerMode;
            if (runnerMetrics.mvConnect) {
                runnerInfo.mvConnectPingP95Ms = runnerMetrics.mvConnect.pingP95Ms;
                runnerInfo.mvConnectRetainPct = runnerMetrics.mvConnect.retainPct;
            }
            metrics.runner = runnerInfo;
        }
        const meta = {
            cpuModel: os.cpus()[0]?.model,
            cpuCores: os.cpus().length,
            totalMemGb: Math.round(os.totalmem() / 1e9),
            platform: `${os.type()} ${os.release()}`,
            nodeVersion: process.version,
            coreVersion: opts.config?.coreVersion,
            loadedAddons: catalog.addons.filter((a) => a.enabled).map((a) => a.id),
            runnerName,
            runner: runnerInfo,
            phases,
        };

        const scoreKeys = scoreKeysForPhases(phases);
        const overall = overallScore(scores, scoreKeys);
        const reportName = benchReportFilename(new Date());
        const html = buildBenchReportHtml({
            runId,
            status,
            startedAt,
            finishedAt: Date.now(),
            scores,
            overall,
            meta,
            metrics,
            failures,
            notes,
        });
        fs.mkdirSync(reportsDir, { recursive: true });
        fs.writeFileSync(path.join(reportsDir, reportName), html, 'utf8');
        pruneOldReports(reportsDir, opts.config);

        patchRun(db, runId, {
            status,
            phase: 'done',
            scores_json: JSON.stringify(scores),
            metrics_json: JSON.stringify(metrics),
            report_filename: reportName,
            finished_at: Date.now(),
        });

        activeRuns.delete(runId);
    }
}

/**
 * @param {number} opsPerSec
 */
function scoreHwCpu(opsPerSec) {
    if (hwCpuCalibration > 0) {
        return clampScore((opsPerSec / hwCpuCalibration) * 80);
    }
    return clampScore(Math.min(100, opsPerSec / 1000));
}

/**
 * @param {{ readMbps: number, writeMbps: number, checksumOk: boolean }} mem
 */
function scoreHwMem(mem) {
    const speed = clampScore(((mem.readMbps + mem.writeMbps) / 2 / 500) * 100);
    const integrity = mem.checksumOk ? 100 : 0;
    return clampScore(speed * 0.7 + integrity * 0.3);
}

/**
 * @param {{ voice?: number, pdf?: number, video?: number }} av
 */
function scoreAudioVc(av) {
    const v = typeof av.voice === 'number' ? av.voice : 0;
    const p = typeof av.pdf === 'number' ? av.pdf : 0;
    const vi = typeof av.video === 'number' ? av.video : 0;
    return (v + p + vi) / 3;
}

/**
 * @param {string} runId
 * @param {string} benchToken
 * @param {object} job
 * @param {string} runnerName
 */
function dispatchRunnerJob(runId, benchToken, job, runnerName) {
    if (!ioRef || !runnerName) return;
    const runner = getRunnerStatusByName(runnerName);
    if (!runner?.socketId) return;
    ioRef.to(runner.socketId).emit('addon:meta-bench-r1:job', {
        runId,
        benchToken,
        deadlineMs: RUN_TIMEOUT_MS,
        ...job,
    });
}

/**
 * @param {string} dir
 * @param {Record<string, unknown>} config
 */
function pruneOldReports(dir, config) {
    const maxFiles =
        typeof config.reportMaxFiles === 'number' ? config.reportMaxFiles : 30;
    const maxAgeDays =
        typeof config.reportMaxAgeDays === 'number' ? config.reportMaxAgeDays : 90;
    const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
    const now = Date.now();
    const files = fs
        .readdirSync(dir)
        .filter((f) => f.startsWith('benchreport') && f.endsWith('.html'))
        .map((f) => ({ f, mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime);

    for (const item of files) {
        if (now - item.mtime > maxAgeMs) {
            try {
                fs.unlinkSync(path.join(dir, item.f));
            } catch {
                /* ignore */
            }
        }
    }

    const remaining = fs
        .readdirSync(dir)
        .filter((f) => f.startsWith('benchreport') && f.endsWith('.html'))
        .map((f) => ({ f, mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime);

    for (let i = maxFiles; i < remaining.length; i++) {
        try {
            fs.unlinkSync(path.join(dir, remaining[i].f));
        } catch {
            /* ignore */
        }
    }
}

/**
 * @param {number} ms
 */
function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

export function isRunOrchestratorBusy() {
    return isBenchMaintenance() || activeRuns.size > 0;
}
