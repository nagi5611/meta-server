// addons/avator-scalable-animations/server.js — キー割当アニメ設定をクライアントへ公開
import { HOOKS } from '../../lib/hook-registry.js';

/**
 * config.bindings（配列または JSON 文字列）を検証して正規化する。
 * @param {unknown} raw
 * @returns {{ name: string, key: string, clipIndex?: number, clipName?: string }[]}
 */
function parseBindings(raw) {
    /** @type {unknown} */
    let arr = raw;
    if (typeof raw === 'string') {
        try {
            arr = JSON.parse(raw);
        } catch {
            return [];
        }
    }
    if (!Array.isArray(arr)) return [];

    /** @type {{ name: string, key: string, clipIndex?: number, clipName?: string }[]} */
    const out = [];
    for (const item of arr) {
        if (!item || typeof item !== 'object') continue;
        const o = /** @type {Record<string, unknown>} */ (item);
        const name = typeof o.name === 'string' ? o.name.trim() : '';
        const key = typeof o.key === 'string' ? o.key.trim() : '';
        if (!name || !key) continue;

        let clipIndex;
        if (typeof o.clipIndex === 'number' && Number.isFinite(o.clipIndex)) {
            clipIndex = Math.trunc(o.clipIndex);
        } else if (typeof o.clipIndex === 'string' && o.clipIndex.trim()) {
            const n = Number(o.clipIndex.trim());
            if (Number.isFinite(n)) clipIndex = Math.trunc(n);
        }

        const clipName = typeof o.clipName === 'string' && o.clipName.trim() ? o.clipName.trim() : '';

        if (clipIndex === undefined && !clipName) continue;

        /** @type {{ name: string, key: string, clipIndex?: number, clipName?: string }} */
        const entry = { name, key };
        if (clipIndex !== undefined) entry.clipIndex = clipIndex;
        if (clipName) entry.clipName = clipName;
        out.push(entry);
    }
    return out;
}

export default {
    /**
     * @param {object} ctx
     */
    async register(ctx) {
        const bindings = parseBindings(ctx.config.bindings);

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
