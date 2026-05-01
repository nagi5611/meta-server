// addons/admin-reboot/client/admin.js - 管理画面ステータスに再起動UIを追加

/**
 * 再起動 API を呼び出して結果を返す。
 * @param {string} endpoint
 * @returns {Promise<{ ok: boolean, message?: string, error?: string }>}
 */
async function callRebootApi(endpoint) {
    const res = await fetch(endpoint, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
        return { ok: false, error: body.error || res.statusText };
    }
    return { ok: true, message: body.message };
}

/**
 * ステータスパネルに再起動UIを組み立てる。
 * @returns {void}
 */
function mountAdminRebootPanel() {
    if (document.getElementById('addon-admin-reboot-panel')) return;
    const statusPanel = document.getElementById('panel-status');
    if (!statusPanel) return;

    const section = document.createElement('section');
    section.id = 'addon-admin-reboot-panel';
    section.className = 'stats-section addon-admin-reboot-section';
    section.innerHTML = `
        <h2>Admin Reboot</h2>
        <p class="status-text">systemctl restart による Node サーバー再起動を実行します（管理者専用）。</p>
        <div class="addon-admin-reboot-actions">
            <button type="button" class="btn btn-primary" id="addon-admin-reboot-node-btn">サーバー再起動 (systemctl)</button>
        </div>
        <p class="status-text" id="addon-admin-reboot-status" role="status"></p>
    `;
    statusPanel.appendChild(section);

    const nodeBtn = /** @type {HTMLButtonElement | null} */ (document.getElementById('addon-admin-reboot-node-btn'));
    const statusEl = document.getElementById('addon-admin-reboot-status');
    if (!nodeBtn || !statusEl) return;

    const setStatus = (text, isError = false) => {
        statusEl.textContent = text;
        statusEl.classList.toggle('error', isError);
        statusEl.classList.toggle('success', !isError && text.length > 0);
    };

    const setBusy = (busy) => {
        nodeBtn.disabled = busy;
    };

    const initCapabilities = async () => {
        try {
            const res = await fetch('/admin/addons/admin-reboot/capabilities', {
                credentials: 'same-origin',
            });
            const cap = await res.json().catch(() => ({}));
            if (!res.ok || !cap.ok) throw new Error(cap.error || res.statusText);
            nodeBtn.disabled = !cap.allowNodeRestart;
            setStatus(
                `方式=${cap.strategy || 'systemctl-restart'} / service=${cap.serviceName || '-'} / Node再起動=${cap.allowNodeRestart ? '可' : '不可'}`,
                false
            );
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            nodeBtn.disabled = true;
            setStatus(`機能の初期化に失敗: ${message}`, true);
        }
    };

    nodeBtn.addEventListener('click', async () => {
        const ok = window.confirm('Node.js プロセスを再起動します。実行しますか？');
        if (!ok) return;
        setBusy(true);
        setStatus('Node再起動を要求中...');
        const result = await callRebootApi('/admin/addons/admin-reboot/restart-node');
        setBusy(false);
        if (!result.ok) return setStatus(`Node再起動に失敗: ${result.error || 'unknown_error'}`, true);
        setStatus(result.message || 'Node再起動を要求しました。', false);
    });

    void initCapabilities();
}

/**
 * 初期化する。
 * @returns {void}
 */
function initAdminRebootAddon() {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            mountAdminRebootPanel();
        });
        return;
    }
    mountAdminRebootPanel();
}

initAdminRebootAddon();
