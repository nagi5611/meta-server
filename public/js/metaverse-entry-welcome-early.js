// public/js/metaverse-entry-welcome-early.js — メタバース HTML 解析直後に Welcome を即表示（モジュール読込前）

(function mountEarlyEntryWelcome() {
    try {
        const raw = sessionStorage.getItem('metaverse_pending_welcome_v1');
        if (!raw) return;

        const data = JSON.parse(raw);
        const displayName = typeof data?.displayName === 'string' ? data.displayName.trim() : '';
        const lead = typeof data?.welcomeLead === 'string' ? data.welcomeLead : '';
        const body = typeof data?.welcomeBody === 'string' ? data.welcomeBody : '';
        const closing = typeof data?.welcomeClosing === 'string' ? data.welcomeClosing : '';
        if (!displayName || !lead || !closing) return;

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
                padding: 24px;
                box-sizing: border-box;
                background: #ffffff;
                opacity: 1;
                transition: opacity 1s ease;
                pointer-events: auto;
            }
            #met-entry-welcome-root.met-entry-welcome-fading {
                opacity: 0;
                pointer-events: none;
            }
            #met-entry-welcome-root .met-entry-welcome-inner {
                max-width: 28rem;
                text-align: center;
                font-family: 'Segoe UI', system-ui, -apple-system, sans-serif;
                color: #1d1d1f;
            }
            #met-entry-welcome-root .met-entry-welcome-lead {
                margin: 0 0 1.25rem;
                font-size: clamp(2.25rem, 10vw, 3.5rem);
                font-weight: 600;
                letter-spacing: 0.06em;
                line-height: 1.15;
            }
            #met-entry-welcome-root .met-entry-welcome-body {
                margin: 0 0 0.85rem;
                font-size: clamp(0.95rem, 3.8vw, 1.1rem);
                font-weight: 400;
                line-height: 1.65;
                color: #5c5c60;
            }
            #met-entry-welcome-root .met-entry-welcome-body:empty {
                display: none;
            }
            #met-entry-welcome-root .met-entry-welcome-closing {
                margin: 0;
                font-size: clamp(1.05rem, 4.2vw, 1.25rem);
                font-weight: 600;
                line-height: 1.55;
                letter-spacing: 0.02em;
            }
        `;
        document.head.appendChild(style);
        document.documentElement.classList.add('met-entry-welcome-active');

        const root = document.createElement('div');
        root.id = 'met-entry-welcome-root';
        root.setAttribute('role', 'dialog');
        root.setAttribute('aria-modal', 'true');
        root.setAttribute('aria-live', 'polite');

        const inner = document.createElement('div');
        inner.className = 'met-entry-welcome-inner';

        const leadEl = document.createElement('p');
        leadEl.className = 'met-entry-welcome-lead';
        leadEl.textContent = lead;

        const bodyEl = document.createElement('p');
        bodyEl.className = 'met-entry-welcome-body';
        bodyEl.textContent = body;

        const closingEl = document.createElement('p');
        closingEl.className = 'met-entry-welcome-closing';
        closingEl.textContent = closing;

        inner.append(leadEl, bodyEl, closingEl);
        root.appendChild(inner);

        const mount = () => {
            if (document.getElementById('met-entry-welcome-root')) return;
            document.body.prepend(root);
            window.__metWelcomeVisibleAt = Date.now();
        };

        const musicDelayMs = 500;
        const scheduleEarlyWelcomeMusic = () => {
            const visibleAt =
                typeof window.__metWelcomeVisibleAt === 'number' ? window.__metWelcomeVisibleAt : Date.now();
            const delayMs = Math.max(0, musicDelayMs - (Date.now() - visibleAt));
            window.__metWelcomeMusicPlayTimer = window.setTimeout(function () {
                window.__metWelcomeMusicPlayTimer = null;
                const audio =
                    window.__metWelcomeMusic instanceof HTMLAudioElement
                        ? window.__metWelcomeMusic
                        : new Audio('/music/login.mp3');
                audio.preload = 'auto';
                audio.volume = 0.85;
                window.__metWelcomeMusic = audio;
                if (audio.paused) {
                    audio.currentTime = 0;
                    void audio.play().catch(function () {});
                }
            }, delayMs);
        };

        const onReady = () => {
            mount();
            scheduleEarlyWelcomeMusic();
        };

        if (document.body) onReady();
        else document.addEventListener('DOMContentLoaded', onReady, { once: true });
    } catch {
        /* ignore */
    }
})();
