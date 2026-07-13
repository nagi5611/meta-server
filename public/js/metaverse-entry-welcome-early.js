// public/js/metaverse-entry-welcome-early.js — メタバース HTML 解析直後に Welcome を即表示（モジュール読込前）

(function mountEarlyEntryWelcome() {
    try {
        const raw = sessionStorage.getItem('metaverse_pending_welcome_v1');
        if (!raw) return;

        const data = JSON.parse(raw);
        const displayName = typeof data?.displayName === 'string' ? data.displayName.trim() : '';
        if (!displayName) return;

        const CF_ORANGE = '#f38020';
        const CF_ORANGE_RGB = '243, 128, 32';

        const style = document.createElement('style');
        style.id = 'met-entry-welcome-early-styles';
        style.textContent = `
            html.met-entry-welcome-active,
            html.met-entry-welcome-active body {
                overflow: hidden !important;
                background: #fafafa !important;
            }
            #met-entry-welcome-root {
                --met-accent: ${CF_ORANGE};
                --met-accent-rgb: ${CF_ORANGE_RGB};
                position: fixed;
                inset: 0;
                z-index: 100000;
                display: flex;
                align-items: center;
                justify-content: center;
                font-family: 'Segoe UI', system-ui, -apple-system, sans-serif;
                color: #1d1d1f;
                background: #fafafa;
            }
            #met-entry-welcome-root .met-entry-bg {
                position: absolute;
                inset: 0;
                background:
                    radial-gradient(ellipse 90% 70% at 50% -10%, rgba(var(--met-accent-rgb), 0.14), transparent 55%),
                    linear-gradient(180deg, #ffffff 0%, #f6f6f7 48%, #fafafa 100%);
            }
            #met-entry-welcome-root .met-entry-card {
                position: relative;
                z-index: 2;
                width: min(92vw, 420px);
                padding: 40px 32px 36px;
                border-radius: 16px;
                background: #fff;
                border: 1px solid rgba(0, 0, 0, 0.06);
                box-shadow: 0 12px 40px rgba(0, 0, 0, 0.08);
                text-align: center;
            }
            #met-entry-welcome-root .met-entry-welcome-badge {
                display: inline-flex;
                align-items: center;
                justify-content: center;
                width: 56px;
                height: 56px;
                border-radius: 50%;
                background: rgba(var(--met-accent-rgb), 0.12);
                color: var(--met-accent);
                font-size: 1.75rem;
                margin-bottom: 4px;
            }
            #met-entry-welcome-root .met-entry-welcome-label {
                font-size: clamp(2rem, 8vw, 2.75rem);
                font-weight: 800;
                margin: 0;
                color: #1d1d1f;
            }
            #met-entry-welcome-root .met-entry-welcome-name {
                font-size: clamp(1.1rem, 4vw, 1.45rem);
                font-weight: 600;
                color: var(--met-accent);
                margin: 8px 0 0;
            }
            #met-entry-welcome-root .met-entry-welcome-sub {
                font-size: 0.9rem;
                color: #6b6b6f;
                margin: 12px 0 0;
            }
            #met-entry-welcome-root .met-entry-progress {
                position: absolute;
                bottom: 0;
                left: 0;
                right: 0;
                height: 3px;
                background: rgba(0, 0, 0, 0.04);
                overflow: hidden;
            }
            #met-entry-welcome-root .met-entry-progress-bar {
                height: 100%;
                width: 40%;
                background: linear-gradient(90deg, transparent, var(--met-accent), transparent);
                animation: metEntryWelcomeProgress 1.8s ease-in-out infinite;
            }
            @keyframes metEntryWelcomeProgress {
                0% { transform: translateX(-120%); }
                100% { transform: translateX(320%); }
            }
        `;
        document.head.appendChild(style);
        document.documentElement.classList.add('met-entry-welcome-active');

        const root = document.createElement('div');
        root.id = 'met-entry-welcome-root';
        root.setAttribute('role', 'dialog');
        root.setAttribute('aria-modal', 'true');
        root.setAttribute('aria-live', 'polite');
        root.innerHTML = `
            <div class="met-entry-bg" aria-hidden="true"></div>
            <div class="met-entry-card">
                <div class="met-entry-welcome-badge" aria-hidden="true">✓</div>
                <p class="met-entry-welcome-label">Welcome!</p>
                <p class="met-entry-welcome-name"></p>
                <p class="met-entry-welcome-sub">ワールドを準備しています</p>
            </div>
            <div class="met-entry-progress" aria-hidden="true">
                <div class="met-entry-progress-bar"></div>
            </div>
        `;

        const nameEl = root.querySelector('.met-entry-welcome-name');
        if (nameEl) nameEl.textContent = displayName;

        const mount = () => {
            if (document.getElementById('met-entry-welcome-root')) return;
            document.body.prepend(root);
        };

        if (document.body) mount();
        else document.addEventListener('DOMContentLoaded', mount, { once: true });
    } catch {
        /* ignore */
    }
})();
