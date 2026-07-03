// addons/meta-bench-r1/server.js
import fs from 'node:fs';
import express from 'express';
import { STORAGE_PATHS } from '../../config/storage-paths.js';
import path from 'node:path';
import { HOOKS } from '../../lib/hook-registry.js';
import { verifyBenchToken } from '../../lib/bench-maintenance.js';
import { setBenchRunnerSecret } from '../../lib/bench-runner-auth.js';
import {
    registerRunner,
    heartbeatRunner,
    attachRunnerSocket,
    getRunnerStatus,
    createPairingCode,
    getPairingCode,
    consumePairingCode,
    safeEqualSecret,
} from './lib/runner-registry.js';
import {
    initRunOrchestrator,
    startRun,
    abortRun,
    getRunPublic,
    listRunsPublic,
    evaluatePreflight,
    ingestRunnerMetrics,
} from './lib/run-orchestrator.js';
import { scorePacketLoss } from './lib/scoring.js';
import {
    normalizeBenchPdfPath,
} from './lib/bench-pdf-path.js';

const JSON_LIMIT = '64kb';

/**
 * @param {import('express').Request} req
 * @returns {string}
 */
function getRunnerSecretFromRequest(req, configSecret) {
    const hdr = req.headers.authorization;
    if (typeof hdr === 'string' && hdr.startsWith('Bearer ')) {
        return hdr.slice(7).trim();
    }
    if (req.body && typeof req.body.secret === 'string') return req.body.secret.trim();
    if (req.body && typeof req.body.runnerSecret === 'string') return req.body.runnerSecret.trim();
    return '';
}

export default {
    /**
     * @param {import('../../lib/plugin-loader.js').PluginRegisterApi} ctx
     */
    async register(ctx) {
        const db = ctx.openDatabase();
        const reportsDir = path.join(ctx.paths.addonRoot, 'reports');
        if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir, { recursive: true });

        const runnerSecret =
            typeof ctx.config.runnersecret === 'string'
                ? ctx.config.runnersecret
                : typeof ctx.config.runnerSecret === 'string'
                  ? ctx.config.runnerSecret
                  : '';

        setBenchRunnerSecret(runnerSecret);

        const defaultBotCount =
            typeof ctx.config.defaultBotCount === 'number' ? ctx.config.defaultBotCount : 25;

        const benchPdfPath = normalizeBenchPdfPath(ctx.config.benchPdfPath);

        const hwCalibration =
            typeof ctx.config.hwCpuCalibrationOpsPerSec === 'number'
                ? ctx.config.hwCpuCalibrationOpsPerSec
                : 0;

        let worldsReader = () => {
            try {
                const data = JSON.parse(fs.readFileSync(STORAGE_PATHS.WORLDS_PATH, 'utf8'));
                const keys = Object.keys(data || {});
                return keys.length ? keys : ['default'];
            } catch {
                return ['default'];
            }
        };

        ctx.hooks.on(HOOKS.EXPRESS_SETUP, ({ app }) => {
            initRunOrchestrator({
                reportsDir,
                addonDbPath: ctx.paths.pluginDbPath,
                hwCpuCalibration: hwCalibration,
            });

            const jsonMw = express.json({ limit: JSON_LIMIT });

            app.get('/admin/addons/meta-bench-r1/runner/status', (_req, res) => {
                res.json({ ok: true, runner: getRunnerStatus() });
            });

            app.get('/admin/addons/meta-bench-r1/runner/pairing-code', (_req, res) => {
                const code = createPairingCode();
                const info = getPairingCode();
                res.json({ ok: true, code, expiresAt: info?.expiresAt ?? null });
            });

            app.get('/admin/addons/meta-bench-r1/preflight', (req, res) => {
                const botCount = parseInt(String(req.query.botCount || defaultBotCount), 10);
                const result = evaluatePreflight(db, Number.isFinite(botCount) ? botCount : defaultBotCount);
                res.json({ ok: result.ok, failures: result.failures });
            });

            app.post('/admin/addons/meta-bench-r1/runs', jsonMw, async (req, res) => {
                try {
                    const botCount = parseInt(String(req.body?.botCount ?? defaultBotCount), 10);
                    const worlds = worldsReader();
                    const run = await startRun(db, {
                        botCount: Number.isFinite(botCount) ? botCount : defaultBotCount,
                        worlds,
                        pdfPath: benchPdfPath,
                        config: { ...ctx.config, coreVersion: ctx.coreVersion },
                    });
                    res.status(201).json({ ok: true, ...run });
                } catch (e) {
                    const failures = e && e.failures ? e.failures : [e instanceof Error ? e.message : String(e)];
                    res.status(400).json({ ok: false, failures });
                }
            });

            app.get('/admin/addons/meta-bench-r1/runs', (req, res) => {
                const limit = parseInt(String(req.query.limit ?? '30'), 10);
                const runs = listRunsPublic(db, Number.isFinite(limit) ? limit : 30);
                res.json({ ok: true, runs });
            });

            app.get('/admin/addons/meta-bench-r1/runs/:id', (req, res) => {
                const run = getRunPublic(db, req.params.id);
                if (!run) return res.status(404).json({ ok: false, error: 'not_found' });
                res.json({ ok: true, run });
            });

            app.post('/admin/addons/meta-bench-r1/runs/:id/abort', (req, res) => {
                abortRun(db, req.params.id);
                res.json({ ok: true });
            });

            app.get('/admin/addons/meta-bench-r1/reports/:filename', (req, res) => {
                const name = path.basename(req.params.filename);
                if (!name.startsWith('benchreport') || !name.endsWith('.html')) {
                    return res.status(400).json({ ok: false, error: 'invalid_filename' });
                }
                const fp = path.join(reportsDir, name);
                if (!fs.existsSync(fp)) return res.status(404).json({ ok: false, error: 'not_found' });
                res.type('text/html; charset=utf-8').sendFile(fp);
            });

            app.post(`${ctx.paths.httpBasePath}/runner/register`, jsonMw, (req, res) => {
                const secret = getRunnerSecretFromRequest(req, runnerSecret);
                const pairing = req.body?.pairingCode;
                const name = typeof req.body?.name === 'string' ? req.body.name.trim() : 'runner';
                const recommendedMaxBots = parseInt(String(req.body?.recommendedMaxBots ?? 50), 10);

                const secretOk = runnerSecret && safeEqualSecret(secret, runnerSecret);
                const pairingOk = pairing && consumePairingCode(String(pairing));
                if (!secretOk && !pairingOk) {
                    return res.status(403).json({ ok: false, error: 'unauthorized' });
                }

                registerRunner({
                    name,
                    recommendedMaxBots: Number.isFinite(recommendedMaxBots) ? recommendedMaxBots : 50,
                });
                res.json({ ok: true, runner: getRunnerStatus() });
            });

            app.post(`${ctx.paths.httpBasePath}/runner/heartbeat`, jsonMw, (req, res) => {
                const secret = getRunnerSecretFromRequest(req, runnerSecret);
                if (!runnerSecret || !safeEqualSecret(secret, runnerSecret)) {
                    return res.status(403).json({ ok: false, error: 'unauthorized' });
                }
                if (!heartbeatRunner()) {
                    return res.status(404).json({ ok: false, error: 'runner_not_registered' });
                }
                res.json({ ok: true });
            });

            app.post(`${ctx.paths.httpBasePath}/runs/:id/metrics`, jsonMw, (req, res) => {
                const token =
                    (typeof req.headers.authorization === 'string' &&
                    req.headers.authorization.startsWith('Bearer ')
                        ? req.headers.authorization.slice(7)
                        : null) ||
                    req.body?.benchToken;
                const verified = verifyBenchToken(token);
                if (!verified || verified.runId !== req.params.id) {
                    return res.status(403).json({ ok: false, error: 'invalid_bench_token' });
                }

                const body = req.body || {};
                /** @type {Record<string, unknown>} */
                const normalized = { ...body };
                delete normalized.benchToken;

                if (body.mvConnect) {
                    normalized.mvConnect = body.mvConnect;
                }
                if (body.audioVc) {
                    const av = body.audioVc;
                    normalized.audioVc = {
                        voice: scorePacketLoss(av.voiceLossPct ?? 100),
                        pdf: scorePacketLoss(av.pdfLossPct ?? 100),
                        video: scorePacketLoss(av.videoLossPct ?? 100),
                        raw: av,
                    };
                }

                ingestRunnerMetrics(db, req.params.id, normalized);
                res.json({ ok: true });
            });
        });

        ctx.hooks.on(HOOKS.SOCKET_SETUP, ({ io }) => {
            initRunOrchestrator({ io });

            io.on('connection', (socket) => {
                socket.on('addon:meta-bench-r1:runner-attach', (payload, ack) => {
                    const secret = payload?.runnerSecret;
                    if (!runnerSecret || !safeEqualSecret(String(secret || ''), runnerSecret)) {
                        if (typeof ack === 'function') ack({ ok: false, error: 'unauthorized' });
                        return;
                    }
                    attachRunnerSocket(socket.id);
                    if (typeof ack === 'function') ack({ ok: true });
                });

                socket.on('addon:meta-bench-r1:progress', (payload) => {
                    if (!payload?.runId) return;
                    ctx.logger.info(`run ${payload.runId} progress: ${payload.phase} ${payload.percent ?? '-'}%`);
                });
            });
        });

        ctx.hooks.on(HOOKS.SHUTDOWN, () => {
            ctx.logger.info('shutdown');
        });

        ctx.logger.info('registered');
    },
};
