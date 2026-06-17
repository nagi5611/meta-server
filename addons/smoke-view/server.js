// addons/smoke-view/server.js — Play_VDB 検証ページと静的アセット配信
import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { HOOKS } from '../../lib/hook-registry.js';

export default {
    /**
     * @param {object} ctx plugin context
     */
    async register(ctx) {
        const playVdbRoot = path.join(ctx.paths.addonRoot, 'play_vdb');
        const playVdbIndex = path.join(playVdbRoot, 'index.html');

        ctx.hooks.on(HOOKS.EXPRESS_SETUP, ({ app }) => {
            const sendPlayVdbIndex = (_req, res) => {
                if (!fs.existsSync(playVdbIndex)) {
                    return res.status(503).type('text/plain').send('play_vdb/index.html not found');
                }
                res.sendFile(playVdbIndex);
            };

            app.get('/play_vdb', sendPlayVdbIndex);
            app.get('/play_vdb/', sendPlayVdbIndex);
            app.use('/play_vdb', express.static(playVdbRoot));
        });

        ctx.logger.info('registered (Play_VDB at /play_vdb)');
    },
};
