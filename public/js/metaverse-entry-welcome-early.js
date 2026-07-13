// public/js/metaverse-entry-welcome-early.js — メタバース HTML 解析直後に Welcome を即表示（モジュール読込前）

(function mountEarlyEntryWelcome() {
    try {
        const raw = sessionStorage.getItem('metaverse_pending_welcome_v1');
        if (!raw) return;

        const data = JSON.parse(raw);
        const displayName = typeof data?.displayName === 'string' ? data.displayName.trim() : '';
        if (!displayName) return;

        const style = document.createElement('style');
        style.id = 'met-entry-welcome-early-styles';
        style.textContent = `
            html.met-entry-welcome-active,
            html.met-entry-welcome-active body {
                overflow: hidden !important;
                background: #ffffff !important;
            }
            #met-entry-welcome-root {
                position: fixed;
                inset: 0;
                z-index: 100000;
                display: flex;
                align-items: center;
                justify-content: center;
                background: #ffffff;
                opacity: 1;
                transition: opacity 1s ease;
                pointer-events: auto;
            }
            #met-entry-welcome-root.met-entry-welcome-fading {
                opacity: 0;
                pointer-events: none;
            }
            #met-entry-welcome-root .met-entry-welcome-text {
                margin: 0;
                font-family: 'Segoe UI', system-ui, -apple-system, sans-serif;
                font-size: clamp(2.5rem, 11vw, 4rem);
                font-weight: 300;
                letter-spacing: 0.04em;
                color: #1d1d1f;
            }
        `;
        document.head.appendChild(style);
        document.documentElement.classList.add('met-entry-welcome-active');

        const root = document.createElement('div');
        root.id = 'met-entry-welcome-root';
        root.setAttribute('role', 'dialog');
        root.setAttribute('aria-modal', 'true');
        root.setAttribute('aria-live', 'polite');
        root.innerHTML = '<p class="met-entry-welcome-text">Welcome</p>';

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
