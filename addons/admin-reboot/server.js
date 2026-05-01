// addons/admin-reboot/server.js - Admin ステータスに再起動APIを提供
import os from 'node:os';
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
 * OSごとの再起動コマンドを返す。
 * @returns {{ command: string, args: string[] } | null}
 */
function getSystemRebootCommand() {
    const platform = os.platform();
    if (platform === 'win32') return { command: 'shutdown', args: ['/r', '/t', '0'] };
    if (platform === 'linux') return { command: 'systemctl', args: ['reboot'] };
    if (platform === 'darwin') return { command: 'shutdown', args: ['-r', 'now'] };
    return null;
}

/**
 * システム再起動コマンドを非同期で起動する。
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
        const allowSystemReboot = parseBoolean(ctx.config.allowSystemReboot, false);

        ctx.hooks.on(HOOKS.EXPRESS_SETUP, ({ app }) => {
            app.get('/admin/addons/admin-reboot/capabilities', (_req, res) => {
                res.json({
                    ok: true,
                    plugin: ctx.pluginId,
                    allowNodeRestart,
                    allowSystemReboot,
                    platform: os.platform(),
                });
            });

            app.post('/admin/addons/admin-reboot/restart-node', (_req, res) => {
                if (!allowNodeRestart) {
                    return res.status(403).json({ ok: false, error: 'node_restart_disabled' });
                }
                res.json({
                    ok: true,
                    message: 'Node.js プロセスの再起動を要求しました。プロセスマネージャー配下なら自動復帰します。',
                });
                setTimeout(() => {
                    process.exit(0);
                }, 180);
            });

            app.post('/admin/addons/admin-reboot/reboot-system', (_req, res) => {
                if (!allowSystemReboot) {
                    return res.status(403).json({ ok: false, error: 'system_reboot_disabled' });
                }
                const rebootSpec = getSystemRebootCommand();
                if (!rebootSpec) {
                    return res.status(400).json({ ok: false, error: 'unsupported_platform' });
                }
                try {
                    runDetachedCommand(rebootSpec);
                    return res.json({
                        ok: true,
                        message: `OS再起動コマンドを実行しました: ${rebootSpec.command} ${rebootSpec.args.join(' ')}`,
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
