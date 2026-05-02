// addons/admin-reboot/client/admin.js - 管理画面ステータスに再起動UIを追加

/**
 * 再起動 API を呼び出して結果を返す。
 * @param {string} endpoint
 * @param {Record<string, string>} [body]
 * @returns {Promise<{ ok: boolean, message?: string, error?: string }>}
 */
async function callRebootApi(endpoint, body = {}) {
    const res = await fetch(endpoint, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
        return { ok: false, error: json.error || res.statusText };
    }
    return { ok: true, message: json.message };
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
        <div class="addon-admin-reboot-pin-row" id="addon-admin-reboot-pin-row" hidden>
            <label class="addon-admin-reboot-pin-label" for="addon-admin-reboot-pin">再起動 PIN</label>
            <input type="password" class="addon-admin-reboot-pin-input" id="addon-admin-reboot-pin" name="addon-admin-reboot-pin" autocomplete="off" />
        </div>
        <div class="addon-admin-reboot-actions">
            <button type="button" class="btn btn-primary" id="addon-admin-reboot-node-btn">サーバー再起動 (systemctl)</button>
            <button type="button" class="btn btn-primary" id="addon-admin-reboot-update-btn">サーバーアップデート (restart.sh)</button>
        </div>
        <p class="status-text" id="addon-admin-reboot-status" role="status"></p>
    `;
    statusPanel.appendChild(section);

    const nodeBtn = /** @type {HTMLButtonElement | null} */ (document.getElementById('addon-admin-reboot-node-btn'));
    const updateBtn = /** @type {HTMLButtonElement | null} */ (document.getElementById('addon-admin-reboot-update-btn'));
    const statusEl = document.getElementById('addon-admin-reboot-status');
    const pinRow = document.getElementById('addon-admin-reboot-pin-row');
    const pinInput = /** @type {HTMLInputElement | null} */ (document.getElementById('addon-admin-reboot-pin'));
    if (!nodeBtn || !updateBtn || !statusEl) return;
    /** @type {boolean} */
    let pinRequired = false;

    const setStatus = (text, isError = false) => {
        statusEl.textContent = text;
        statusEl.classList.toggle('error', isError);
        statusEl.classList.toggle('success', !isError && text.length > 0);
    };

    const setBusy = (busy) => {
        nodeBtn.disabled = busy;
        updateBtn.disabled = busy;
    };

    const initCapabilities = async () => {
        try {
            const res = await fetch('/admin/addons/admin-reboot/capabilities', {
                credentials: 'same-origin',
            });
            const cap = await res.json().catch(() => ({}));
            if (!res.ok || !cap.ok) throw new Error(cap.error || res.statusText);
            pinRequired = cap.pinRequired === true;
            if (pinRow) {
                pinRow.hidden = !pinRequired;
            }
            if (pinInput && !pinRequired) {
                pinInput.value = '';
            }
            nodeBtn.disabled = !cap.allowNodeRestart;
            const updateOk = cap.allowServerUpdate !== false && cap.restartScriptPresent === true;
            updateBtn.disabled = !updateOk;
            setStatus(
                `方式=${cap.strategy || 'systemctl-restart'} / service=${cap.serviceName || '-'} / Node再起動=${cap.allowNodeRestart ? '可' : '不可'} / アップデート=${updateOk ? '可' : '不可'} / PIN=${pinRequired ? '必須' : '未設定'}`,
                false
            );
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            nodeBtn.disabled = true;
            updateBtn.disabled = true;
            setStatus(`機能の初期化に失敗: ${message}`, true);
        }
    };

    nodeBtn.addEventListener('click', async () => {
        if (pinRequired) {
            const p = pinInput?.value ?? '';
            if (!p) {
                setStatus('再起動 PIN を入力してください。', true);
                return;
            }
        }
        const ok = window.confirm('Node.js プロセスを再起動します。実行しますか？');
        if (!ok) return;
        setBusy(true);
        setStatus('Node再起動を要求中...');
        const payload = pinRequired && pinInput ? { pin: pinInput.value } : {};
        const result = await callRebootApi('/admin/addons/admin-reboot/restart-node', payload);
        setBusy(false);
        if (!result.ok) return setStatus(`Node再起動に失敗: ${result.error || 'unknown_error'}`, true);
        setStatus(result.message || 'Node再起動を要求しました。', false);
    });

    updateBtn.addEventListener('click', async () => {
        if (pinRequired) {
            const p = pinInput?.value ?? '';
            if (!p) {
                setStatus('再起動 PIN を入力してください。', true);
                return;
            }
        }
        const ok = window.confirm('カレントディレクトリの restart.sh を実行します。実行しますか？');
        if (!ok) return;
        setBusy(true);
        setStatus('サーバーアップデートを要求中...');
        const payload = pinRequired && pinInput ? { pin: pinInput.value } : {};
        const result = await callRebootApi('/admin/addons/admin-reboot/server-update', payload);
        setBusy(false);
        if (!result.ok) return setStatus(`サーバーアップデートに失敗: ${result.error || 'unknown_error'}`, true);
        setStatus(result.message || 'restart.sh を実行しました。', false);
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
