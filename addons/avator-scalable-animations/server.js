// addons/avator-scalable-animations/server.js — キー割当アニメ設定をクライアントへ公開
import { HOOKS } from '../../lib/hook-registry.js';
import { parseAvatorScalableMergedConfig, enrichBindingsWithSlotKeys } from '../../lib/avator-scalable-bindings.js';

export default {
    /**
     * @param {object} ctx
     */
    async register(ctx) {
        const bindings = enrichBindingsWithSlotKeys(parseAvatorScalableMergedConfig(ctx.config));

        ctx.hooks.on(HOOKS.EXPRESS_SETUP, ({ app }) => {
            app.get(`${ctx.paths.httpBasePath}/settings`, (_req, res) => {
                res.json({
                    ok: true,
                    plugin: ctx.pluginId,
                    bindings,
                });
            });
        });

        ctx.logger.info('registered', { bindings: bindings.length });
    },
};
