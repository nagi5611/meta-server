// addons/admin-reboot/server.js - Admin ステータスに再起動APIを提供
import { spawn } from 'node:child_process';
import { HOOKS } from '../../lib/hook-registry.js';

/**
 * 設定値を真偽値に正規化する。
 * @param {unknown} value
 * @param {boolean} fallback
 * @returns {boolean}
 */
function parseBoolean(value, fallback) {
    if (typeof value === 'boolean') return value;
    if (typeof value !== 'string') return fallback;
    const normalized = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
    return fallback;
}

/**
 * コマンドを非同期で起動する。
 * @param {{ command: string, args: string[] }} spec
 */
function runDetachedCommand(spec) {
    const cp = spawn(spec.command, spec.args, {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
    });
    cp.unref();
}

export default {
    /**
     * Admin 再起動 API を登録する。
     * @param {object} ctx
     */
    async register(ctx) {
        const allowNodeRestart = parseBoolean(ctx.config.allowNodeRestart, true);
        const serviceName = typeof ctx.config.systemdServiceName === 'string' && ctx.config.systemdServiceName.trim()
            ? ctx.config.systemdServiceName.trim()
            : 'metaverse-simple';

        ctx.hooks.on(HOOKS.EXPRESS_SETUP, ({ app }) => {
            app.get('/admin/addons/admin-reboot/capabilities', (_req, res) => {
                res.json({
                    ok: true,
                    plugin: ctx.pluginId,
                    allowNodeRestart,
                    strategy: 'systemctl-restart',
                    serviceName,
                });
            });

            app.post('/admin/addons/admin-reboot/restart-node', (_req, res) => {
                if (!allowNodeRestart) {
                    return res.status(403).json({ ok: false, error: 'node_restart_disabled' });
                }
                try {
                    runDetachedCommand({ command: 'systemctl', args: ['restart', serviceName] });
                    return res.json({
                        ok: true,
                        message: `systemctl restart ${serviceName} を実行しました。`,
                    });
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    return res.status(500).json({ ok: false, error: message });
                }
            });
        });

        ctx.logger.info('registered');
    },
};
