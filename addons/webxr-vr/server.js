// addons/webxr-vr/server.js — WebXR VR アドオン（サーバー側は有効フラグのみ）

/** @param {import('../../lib/plugin-loader.js').PluginRegisterApi} ctx */
async function register(ctx) {
    ctx.logger.info('webxr-vr client-only addon registered');
}

export default { register };
