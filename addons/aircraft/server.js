// addons/aircraft/server.js — Socket 上の aircraft-board / aircraft-exit を登録する
import { HOOKS } from '../../lib/hook-registry.js';
import { registerAircraftSocketHandlers } from '../../lib/aircraft-server/register-socket.js';

export default {
    /**
     * @param {object} ctx
     */
    async register(ctx) {
        ctx.hooks.on(HOOKS.SOCKET_SETUP, ({ io }) => {
            registerAircraftSocketHandlers(io);
        });
        ctx.logger.info('registered');
    },
};
