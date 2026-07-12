// public/js/login-entry-transition.js — ログイン後の認証待機・Welcome 演出・入場前プリロード

import {
    isLoginPreloadFresh,
    recordLoginEntryClick,
} from './world-preload.js';

/** 認証フェーズの最短表示時間（ms） */
export const AUTH_PHASE_MIN_MS = 5000;

/** Welcome 演出の表示時間（ms） */
export const WELCOME_PHASE_MS = 4000;

/** @typedef {'guest'|'student'|'teacher'} LoginEntryTheme */

/** @type {Record<LoginEntryTheme, { accent: string, accentRgb: string }>} */
const THEMES = {
    guest: { accent: '#0288d1', accentRgb: '2, 136, 209' },
    student: { accent: '#2e7d32', accentRgb: '46, 125, 50' },
    teacher: { accent: '#ed6c02', accentRgb: '237, 108, 2' },
};

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 演出用スタイルを一度だけ注入する
 */
function ensureTransitionStyles() {
    if (document.getElementById('met-entry-transition-styles')) return;

    const style = document.createElement('style');
    style.id = 'met-entry-transition-styles';
    style.textContent = `
        .met-entry-overlay {
            --met-accent: #0288d1;
            --met-accent-rgb: 2, 136, 209;
            position: fixed;
            inset: 0;
            z-index: 100000;
            display: flex;
            align-items: center;
            justify-content: center;
            overflow: hidden;
            font-family: 'Segoe UI', system-ui, sans-serif;
            color: #fff;
        }

        .met-entry-bg {
            position: absolute;
            inset: 0;
            background:
                radial-gradient(ellipse 80% 60% at 20% 20%, rgba(var(--met-accent-rgb), 0.45), transparent 55%),
                radial-gradient(ellipse 70% 50% at 80% 80%, rgba(var(--met-accent-rgb), 0.35), transparent 50%),
                linear-gradient(160deg, #0a1628 0%, #0d2137 45%, #061018 100%);
            animation: metEntryBgShift 8s ease-in-out infinite alternate;
        }

        @keyframes metEntryBgShift {
            0% { filter: hue-rotate(0deg) brightness(1); }
            100% { filter: hue-rotate(12deg) brightness(1.08); }
        }

        .met-entry-grid {
            position: absolute;
            inset: -20%;
            background-image:
                linear-gradient(rgba(255, 255, 255, 0.04) 1px, transparent 1px),
                linear-gradient(90deg, rgba(255, 255, 255, 0.04) 1px, transparent 1px);
            background-size: 48px 48px;
            transform: perspective(500px) rotateX(58deg) translateY(12%);
            transform-origin: center top;
            opacity: 0.55;
            animation: metEntryGridDrift 12s linear infinite;
            mask-image: linear-gradient(to bottom, transparent, #000 25%, #000 75%, transparent);
        }

        @keyframes metEntryGridDrift {
            from { background-position: 0 0, 0 0; }
            to { background-position: 0 96px, 96px 0; }
        }

        .met-entry-particles {
            position: absolute;
            inset: 0;
            pointer-events: none;
            overflow: hidden;
        }

        .met-entry-particle {
            position: absolute;
            width: 4px;
            height: 4px;
            border-radius: 50%;
            background: rgba(var(--met-accent-rgb), 0.85);
            box-shadow: 0 0 12px rgba(var(--met-accent-rgb), 0.9);
            animation: metEntryParticleFloat var(--dur, 6s) ease-in-out infinite;
            animation-delay: var(--delay, 0s);
            opacity: 0;
        }

        @keyframes metEntryParticleFloat {
            0%, 100% { opacity: 0; transform: translateY(20px) scale(0.5); }
            20%, 80% { opacity: 0.9; }
            50% { transform: translateY(-30vh) scale(1); }
        }

        .met-entry-content {
            position: relative;
            z-index: 2;
            text-align: center;
            padding: 24px;
            width: min(92vw, 520px);
        }

        .met-entry-phase {
            display: flex;
            flex-direction: column;
            align-items: center;
            gap: 20px;
        }

        .met-entry-phase[hidden] {
            display: none !important;
        }

        .met-entry-phase-exit {
            animation: metEntryFadeOut 0.45s ease forwards;
        }

        .met-entry-phase-enter {
            animation: metEntryFadeIn 0.55s ease forwards;
        }

        @keyframes metEntryFadeOut {
            to { opacity: 0; transform: scale(0.96) translateY(-8px); }
        }

        @keyframes metEntryFadeIn {
            from { opacity: 0; transform: scale(0.92) translateY(16px); }
            to { opacity: 1; transform: scale(1) translateY(0); }
        }

        .met-entry-spinner {
            width: 52px;
            height: 52px;
            border: 3px solid rgba(255, 255, 255, 0.15);
            border-top-color: var(--met-accent);
            border-radius: 50%;
            animation: metEntrySpin 0.85s linear infinite;
        }

        @keyframes metEntrySpin {
            to { transform: rotate(360deg); }
        }

        .met-entry-status {
            font-size: 1.15rem;
            font-weight: 600;
            letter-spacing: 0.12em;
            color: rgba(255, 255, 255, 0.92);
        }

        .met-entry-status-dots::after {
            content: '';
            animation: metEntryDots 1.4s steps(4, end) infinite;
        }

        @keyframes metEntryDots {
            0% { content: ''; }
            25% { content: '.'; }
            50% { content: '..'; }
            75% { content: '...'; }
        }

        .met-entry-welcome-label {
            font-size: clamp(2.75rem, 11vw, 5.5rem);
            font-weight: 800;
            line-height: 1.05;
            letter-spacing: -0.03em;
            background: linear-gradient(135deg, #fff 0%, rgba(var(--met-accent-rgb), 1) 55%, #fff 100%);
            background-size: 200% auto;
            -webkit-background-clip: text;
            background-clip: text;
            color: transparent;
            animation: metEntryWelcomePop 0.9s cubic-bezier(0.22, 1.2, 0.36, 1) forwards,
                metEntryWelcomeShine 2.8s ease-in-out 0.4s infinite;
            transform: scale(0.4);
            opacity: 0;
        }

        @keyframes metEntryWelcomePop {
            to { transform: scale(1); opacity: 1; }
        }

        @keyframes metEntryWelcomeShine {
            0%, 100% { background-position: 0% center; }
            50% { background-position: 100% center; }
        }

        .met-entry-welcome-name {
            font-size: clamp(1.25rem, 4.5vw, 1.85rem);
            font-weight: 600;
            color: rgba(255, 255, 255, 0.95);
            animation: metEntryNameIn 0.7s ease 0.35s both;
        }

        @keyframes metEntryNameIn {
            from { opacity: 0; transform: translateY(20px); }
            to { opacity: 1; transform: translateY(0); }
        }

        .met-entry-welcome-sub {
            font-size: 0.95rem;
            color: rgba(255, 255, 255, 0.65);
            letter-spacing: 0.08em;
            animation: metEntryNameIn 0.7s ease 0.55s both;
        }

        .met-entry-welcome-ring {
            position: absolute;
            width: min(70vw, 320px);
            height: min(70vw, 320px);
            border-radius: 50%;
            border: 2px solid rgba(var(--met-accent-rgb), 0.35);
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            pointer-events: none;
            animation: metEntryRingPulse 2.2s ease-out infinite;
        }

        @keyframes metEntryRingPulse {
            0% { transform: translate(-50%, -50%) scale(0.85); opacity: 0.9; }
            100% { transform: translate(-50%, -50%) scale(1.35); opacity: 0; }
        }

        .met-entry-progress {
            position: absolute;
            bottom: 0;
            left: 0;
            right: 0;
            height: 3px;
            background: rgba(255, 255, 255, 0.08);
            overflow: hidden;
        }

        .met-entry-progress-bar {
            height: 100%;
            width: 35%;
            background: linear-gradient(90deg, transparent, var(--met-accent), transparent);
            animation: metEntryProgressSlide 1.6s ease-in-out infinite;
        }

        @keyframes metEntryProgressSlide {
            0% { transform: translateX(-120%); }
            100% { transform: translateX(320%); }
        }
    `;
    document.head.appendChild(style);
}

/**
 * テーマ付き全画面オーバーレイを生成する
 * @param {LoginEntryTheme} theme
 * @returns {HTMLElement}
 */
function createOverlay(theme) {
    const t = THEMES[theme] || THEMES.guest;
    const overlay = document.createElement('div');
    overlay.className = 'met-entry-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-live', 'polite');
    overlay.style.setProperty('--met-accent', t.accent);
    overlay.style.setProperty('--met-accent-rgb', t.accentRgb);

    const particles = Array.from({ length: 18 }, (_, i) => {
        const left = 5 + Math.random() * 90;
        const top = 55 + Math.random() * 40;
        const dur = 5 + Math.random() * 5;
        const delay = Math.random() * 4;
        return `<span class="met-entry-particle" style="left:${left}%;top:${top}%;--dur:${dur}s;--delay:${delay}s"></span>`;
    }).join('');

    overlay.innerHTML = `
        <div class="met-entry-bg" aria-hidden="true"></div>
        <div class="met-entry-grid" aria-hidden="true"></div>
        <div class="met-entry-particles" aria-hidden="true">${particles}</div>
        <div class="met-entry-welcome-ring" aria-hidden="true"></div>
        <div class="met-entry-content">
            <div class="met-entry-phase met-entry-auth">
                <div class="met-entry-spinner" aria-hidden="true"></div>
                <p class="met-entry-status met-entry-status-dots">認証中</p>
            </div>
            <div class="met-entry-phase met-entry-welcome" hidden>
                <p class="met-entry-welcome-label">Welcome!</p>
                <p class="met-entry-welcome-name"></p>
                <p class="met-entry-welcome-sub">メタバースに入ります</p>
            </div>
        </div>
        <div class="met-entry-progress" aria-hidden="true">
            <div class="met-entry-progress-bar"></div>
        </div>
    `;
    return overlay;
}

/**
 * オーバーレイを除去してスクロールを戻す
 * @param {HTMLElement} overlay
 */
function teardownOverlay(overlay) {
    overlay.remove();
    document.body.style.overflow = '';
}

/**
 * Welcome フェーズへ切り替える
 * @param {HTMLElement} overlay
 * @param {string} displayName
 */
async function switchToWelcomePhase(overlay, displayName) {
    const authPhase = overlay.querySelector('.met-entry-auth');
    const welcomePhase = overlay.querySelector('.met-entry-welcome');
    const nameEl = overlay.querySelector('.met-entry-welcome-name');
    if (!authPhase || !welcomePhase) return;

    authPhase.classList.add('met-entry-phase-exit');
    await delay(420);
    authPhase.hidden = true;
    authPhase.classList.remove('met-entry-phase-exit');
    if (nameEl) nameEl.textContent = displayName;
    welcomePhase.hidden = false;
    welcomePhase.classList.add('met-entry-phase-enter');
}

/**
 * 認証 → Welcome → プリロード完了後に遷移する入場演出
 * @param {{
 *   displayName: string,
 *   theme?: LoginEntryTheme,
 *   authTask: () => Promise<unknown>,
 *   onAuthFailed?: (err: unknown) => void,
 *   redirectUrl: string,
 *   preloadStart?: () => Promise<void>,
 * }} options
 * @returns {Promise<boolean>} 遷移したら true
 */
export async function runLoginEntryTransition(options) {
    const {
        displayName,
        theme = 'guest',
        authTask,
        onAuthFailed,
        redirectUrl,
        preloadStart,
    } = options;

    recordLoginEntryClick();

    const authStartedAt = Date.now();
    let resolvedDisplayName = displayName;

    try {
        const authResult = await authTask();
        if (typeof authResult === 'string' && authResult.trim()) {
            resolvedDisplayName = authResult.trim();
        } else if (
            authResult &&
            typeof authResult === 'object' &&
            typeof authResult.displayName === 'string' &&
            authResult.displayName.trim()
        ) {
            resolvedDisplayName = authResult.displayName.trim();
        }
    } catch (err) {
        onAuthFailed?.(err);
        return false;
    }

    const preloadPromise = typeof preloadStart === 'function' ? preloadStart() : Promise.resolve();
    await preloadPromise.catch(() => {});

    if (isLoginPreloadFresh()) {
        window.location.href = redirectUrl;
        return true;
    }

    ensureTransitionStyles();
    const overlay = createOverlay(theme);
    document.body.appendChild(overlay);
    document.body.style.overflow = 'hidden';

    const authElapsed = Date.now() - authStartedAt;
    await delay(Math.max(0, AUTH_PHASE_MIN_MS - authElapsed));

    await switchToWelcomePhase(overlay, resolvedDisplayName);

    await delay(WELCOME_PHASE_MS);

    window.location.href = redirectUrl;
    return true;
}
