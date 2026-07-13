// public/js/login-entry-transition.js — ログイン後の認証待機・Welcome 演出・入場前プリロード

import {
    recordLoginEntryClick,
    setPendingEntryWelcome,
} from './login-preload-state.js';

/** 認証フェーズの最短表示時間（ms） */
export const AUTH_PHASE_MIN_MS = 5000;

/** Cloudflare 風オレンジ（入場演出の共通アクセント） */
const CF_ORANGE = '#f38020';
const CF_ORANGE_RGB = '243, 128, 32';

/** @typedef {'guest'|'student'|'teacher'} LoginEntryTheme */

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * オーバーレイ追加直後にブラウザへ描画機会を与える
 * @returns {Promise<void>}
 */
function waitForOverlayPaint() {
    return new Promise((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(resolve));
    });
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
            --met-accent: ${CF_ORANGE};
            --met-accent-rgb: ${CF_ORANGE_RGB};
            position: fixed;
            inset: 0;
            z-index: 100000;
            display: flex;
            align-items: center;
            justify-content: center;
            overflow: hidden;
            font-family: 'Segoe UI', system-ui, -apple-system, sans-serif;
            color: #1d1d1f;
            background: #fafafa;
        }

        .met-entry-bg {
            position: absolute;
            inset: 0;
            background:
                radial-gradient(ellipse 90% 70% at 50% -10%, rgba(var(--met-accent-rgb), 0.14), transparent 55%),
                radial-gradient(ellipse 60% 50% at 100% 100%, rgba(var(--met-accent-rgb), 0.08), transparent 50%),
                linear-gradient(180deg, #ffffff 0%, #f6f6f7 48%, #fafafa 100%);
        }

        .met-entry-bg-orbs {
            position: absolute;
            inset: 0;
            pointer-events: none;
            overflow: hidden;
        }

        .met-entry-orb {
            position: absolute;
            border-radius: 50%;
            background: rgba(var(--met-accent-rgb), 0.07);
            filter: blur(40px);
            animation: metEntryOrbFloat 14s ease-in-out infinite;
        }

        .met-entry-orb--a {
            width: 280px;
            height: 280px;
            top: 8%;
            left: -4%;
        }

        .met-entry-orb--b {
            width: 220px;
            height: 220px;
            bottom: 6%;
            right: -2%;
            animation-delay: -5s;
        }

        @keyframes metEntryOrbFloat {
            0%, 100% { transform: translate(0, 0) scale(1); }
            50% { transform: translate(12px, -18px) scale(1.06); }
        }

        .met-entry-card {
            position: relative;
            z-index: 2;
            width: min(92vw, 420px);
            padding: 40px 32px 36px;
            border-radius: 16px;
            background: #ffffff;
            border: 1px solid rgba(0, 0, 0, 0.06);
            box-shadow:
                0 1px 2px rgba(0, 0, 0, 0.04),
                0 12px 40px rgba(0, 0, 0, 0.08);
            text-align: center;
        }

        .met-entry-phase {
            display: flex;
            flex-direction: column;
            align-items: center;
            gap: 18px;
        }

        .met-entry-phase[hidden] {
            display: none !important;
        }

        .met-entry-phase-exit {
            animation: metEntryFadeOut 0.4s ease forwards;
        }

        .met-entry-phase-enter {
            animation: metEntryFadeIn 0.5s ease forwards;
        }

        @keyframes metEntryFadeOut {
            to { opacity: 0; transform: translateY(-8px); }
        }

        @keyframes metEntryFadeIn {
            from { opacity: 0; transform: translateY(12px); }
            to { opacity: 1; transform: translateY(0); }
        }

        /* ── 鍵穴ビジュアル ── */
        .met-entry-key-visual {
            position: relative;
            width: 120px;
            height: 120px;
            margin-bottom: 4px;
        }

        .met-entry-key-ring {
            position: absolute;
            inset: 0;
            border-radius: 50%;
            border: 2px solid rgba(var(--met-accent-rgb), 0.2);
            animation: metEntryKeyRingPulse 2.4s ease-out infinite;
        }

        @keyframes metEntryKeyRingPulse {
            0% { transform: scale(0.92); opacity: 0.85; }
            100% { transform: scale(1.18); opacity: 0; }
        }

        .met-entry-keyhole-svg {
            width: 100%;
            height: 100%;
            display: block;
        }

        .met-entry-keyhole-body {
            fill: #ececed;
            stroke: rgba(var(--met-accent-rgb), 0.35);
            stroke-width: 2;
            transition: fill 0.5s ease, stroke 0.5s ease;
        }

        .met-entry-keyhole-slot {
            fill: #c8c8cc;
            transition: fill 0.5s ease;
        }

        .met-entry-key-group {
            transform-origin: 58px 52px;
            transition: transform 0.85s cubic-bezier(0.34, 1.2, 0.64, 1);
        }

        .met-entry-key-shaft {
            fill: var(--met-accent);
        }

        .met-entry-key-head {
            fill: none;
            stroke: var(--met-accent);
            stroke-width: 5;
            stroke-linecap: round;
            transition: stroke-dashoffset 0.6s ease 0.15s;
            stroke-dasharray: 88;
            stroke-dashoffset: 0;
        }

        .met-entry-overlay.met-entry-unlocked .met-entry-key-ring {
            animation: none;
            border-color: rgba(var(--met-accent-rgb), 0.55);
            opacity: 1;
            transform: scale(1);
        }

        .met-entry-overlay.met-entry-unlocked .met-entry-keyhole-body {
            fill: rgba(var(--met-accent-rgb), 0.12);
            stroke: rgba(var(--met-accent-rgb), 0.7);
        }

        .met-entry-overlay.met-entry-unlocked .met-entry-keyhole-slot {
            fill: rgba(var(--met-accent-rgb), 0.25);
        }

        .met-entry-overlay.met-entry-unlocked .met-entry-key-group {
            transform: translate(6px, 8px) rotate(-28deg);
        }

        .met-entry-overlay.met-entry-unlocked .met-entry-key-head {
            stroke-dashoffset: 44;
        }

        .met-entry-overlay.met-entry-unlocked .met-entry-key-visual {
            animation: metEntryUnlockPop 0.5s ease;
        }

        @keyframes metEntryUnlockPop {
            0% { transform: scale(1); }
            40% { transform: scale(1.06); }
            100% { transform: scale(1); }
        }

        .met-entry-status {
            font-size: 1.05rem;
            font-weight: 600;
            letter-spacing: 0.06em;
            color: #3d3d3f;
            margin: 0;
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

        .met-entry-status-sub {
            font-size: 0.82rem;
            color: #6b6b6f;
            margin: -8px 0 0;
            letter-spacing: 0.02em;
        }

        .met-entry-overlay.met-entry-unlocked .met-entry-status {
            color: var(--met-accent);
        }

        .met-entry-welcome-badge {
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
            animation: metEntryWelcomePop 0.65s cubic-bezier(0.22, 1.2, 0.36, 1) both;
        }

        @keyframes metEntryWelcomePop {
            from { transform: scale(0.5); opacity: 0; }
            to { transform: scale(1); opacity: 1; }
        }

        .met-entry-welcome-label {
            font-size: clamp(2rem, 8vw, 2.75rem);
            font-weight: 800;
            line-height: 1.1;
            letter-spacing: -0.02em;
            color: #1d1d1f;
            margin: 0;
            animation: metEntryFadeIn 0.55s ease 0.1s both;
        }

        .met-entry-welcome-name {
            font-size: clamp(1.1rem, 4vw, 1.45rem);
            font-weight: 600;
            color: var(--met-accent);
            margin: 0;
            animation: metEntryFadeIn 0.55s ease 0.25s both;
        }

        .met-entry-welcome-sub {
            font-size: 0.9rem;
            color: #6b6b6f;
            margin: 0;
            animation: metEntryFadeIn 0.55s ease 0.4s both;
        }

        .met-entry-progress {
            position: absolute;
            bottom: 0;
            left: 0;
            right: 0;
            height: 3px;
            background: rgba(0, 0, 0, 0.04);
            overflow: hidden;
        }

        .met-entry-progress-bar {
            height: 100%;
            width: 40%;
            background: linear-gradient(90deg, transparent, var(--met-accent), transparent);
            animation: metEntryProgressSlide 1.8s ease-in-out infinite;
        }

        @keyframes metEntryProgressSlide {
            0% { transform: translateX(-120%); }
            100% { transform: translateX(320%); }
        }
    `;
    document.head.appendChild(style);
}

/** 鍵穴 + 鍵 SVG（インライン） */
const KEYHOLE_SVG = `
<svg class="met-entry-keyhole-svg" viewBox="0 0 120 120" aria-hidden="true">
    <circle class="met-entry-keyhole-body" cx="60" cy="46" r="18"/>
    <path class="met-entry-keyhole-slot" d="M 52 58 L 48 78 L 72 78 L 68 58 Z"/>
    <g class="met-entry-key-group">
        <rect class="met-entry-key-shaft" x="78" y="38" width="28" height="8" rx="2"/>
        <rect class="met-entry-key-shaft" x="98" y="34" width="6" height="6" rx="1"/>
        <rect class="met-entry-key-shaft" x="98" y="44" width="5" height="5" rx="1"/>
        <circle class="met-entry-key-head" cx="72" cy="42" r="14"/>
    </g>
</svg>
`;

/**
 * テーマ付き全画面オーバーレイを生成する
 * @param {LoginEntryTheme} _theme
 * @returns {HTMLElement}
 */
function createOverlay(_theme) {
    const overlay = document.createElement('div');
    overlay.className = 'met-entry-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-live', 'polite');

    overlay.innerHTML = `
        <div class="met-entry-bg" aria-hidden="true"></div>
        <div class="met-entry-bg-orbs" aria-hidden="true">
            <div class="met-entry-orb met-entry-orb--a"></div>
            <div class="met-entry-orb met-entry-orb--b"></div>
        </div>
        <div class="met-entry-card">
            <div class="met-entry-phase met-entry-auth">
                <div class="met-entry-key-visual">
                    <div class="met-entry-key-ring" aria-hidden="true"></div>
                    ${KEYHOLE_SVG}
                </div>
                <p class="met-entry-status met-entry-status-dots">認証中</p>
                <p class="met-entry-status-sub">安全で高速なネットワークを構築しています</p>
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
 * 認証成功時の鍵開錠アニメーション
 * @param {HTMLElement} overlay
 */
async function playKeyUnlockAnimation(overlay) {
    const status = overlay.querySelector('.met-entry-status');
    const sub = overlay.querySelector('.met-entry-status-sub');
    if (status) {
        status.textContent = '認証完了';
        status.classList.remove('met-entry-status-dots');
    }
    if (sub) sub.textContent = '鍵が開きました';
    overlay.classList.add('met-entry-unlocked');
    await delay(900);
}

/**
 * 認証 → 鍵開錠 → メタバースへ遷移（Welcome はメタバース側で表示）
 * @param {{
 *   displayName: string,
 *   theme?: LoginEntryTheme,
 *   authTask: () => Promise<unknown>,
 *   onAuthFailed?: (err: unknown) => void,
 *   redirectUrl: string,
 * }} options
 * @returns {Promise<boolean>}
 */
export async function runLoginEntryTransition(options) {
    const {
        displayName,
        theme = 'guest',
        authTask,
        onAuthFailed,
        redirectUrl,
    } = options;

    recordLoginEntryClick();
    ensureTransitionStyles();

    const overlay = createOverlay(theme);
    document.body.appendChild(overlay);
    document.body.style.overflow = 'hidden';
    await waitForOverlayPaint();

    let resolvedDisplayName = displayName;

    let authResult;
    try {
        [authResult] = await Promise.all([authTask(), delay(AUTH_PHASE_MIN_MS)]);
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
        teardownOverlay(overlay);
        onAuthFailed?.(err);
        return false;
    }

    await playKeyUnlockAnimation(overlay);

    const status = overlay.querySelector('.met-entry-status');
    const sub = overlay.querySelector('.met-entry-status-sub');
    if (status) {
        status.textContent = 'メタバースへ入場中';
        status.classList.remove('met-entry-status-dots');
    }
    if (sub) sub.textContent = 'ワールドを準備しています';

    setPendingEntryWelcome({ displayName: resolvedDisplayName, theme });
    window.location.href = redirectUrl;
    return true;
}
