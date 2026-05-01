// addons/sample-echo/server.js — サンプルアドオン（HTTP + Socket）
import { HOOKS } from '../../lib/hook-registry.js';

export default {
    /**
     * @param {object} ctx plugin context（lib/plugin-loader の register に渡される）
     */
    async register(ctx) {
        ctx.openDatabase();

        const greeting = typeof ctx.config.greeting === 'string' ? ctx.config.greeting : 'sample-echo';

        ctx.hooks.on(HOOKS.EXPRESS_SETUP, ({ app }) => {
            app.get(`${ctx.paths.httpBasePath}/hello`, (_req, res) => {
                res.json({
                    ok: true,
                    plugin: ctx.pluginId,
                    greeting,
                    coreVersion: ctx.coreVersion,
                });
            });
        });

        ctx.hooks.on(HOOKS.SOCKET_SETUP, ({ io }) => {
            io.on('connection', (socket) => {
                socket.on(`${ctx.paths.socketPrefix}:ping`, () => {
                    socket.emit(`${ctx.paths.socketPrefix}:pong`, { t: Date.now(), plugin: ctx.pluginId });
                });
            });
        });

        ctx.logger.info('registered');
    },
};
