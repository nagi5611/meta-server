// public/js/login-entry-transition.js — ログイン後の認証待機・Welcome 演出・入場前プリロード

import {
    isLoginPreloadFresh,
    recordLoginEntryClick,
} from './world-preload.js';

/** 認証フェーズの最短表示時間（ms） */
export const AUTH_PHASE_MIN_MS = 5000;

/** Welcome 演出の表示時間（ms） */
export const WELCOME_PHASE_MS = 4000;

/** 鍵が開くアニメーション時間（ms） */
const UNLOCK_ANIM_MS = 900;

/** Cloudflare 風オレンジ */
const CF_ORANGE = '#F6821F';
const CF_ORANGE_RGB = '246, 130, 31';

/** @typedef {'guest'|'student'|'teacher'} LoginEntryTheme */

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
            --met-orange: ${CF_ORANGE};
            --met-orange-rgb: ${CF_ORANGE_RGB};
            position: fixed;
            inset: 0;
            z-index: 100000;
            display: flex;
            align-items: center;
            justify-content: center;
            overflow: hidden;
            font-family: 'Segoe UI', system-ui, -apple-system, sans-serif;
            color: #1a1a1a;
        }

        .met-entry-bg {
            position: absolute;
            inset: 0;
            background:
                radial-gradient(ellipse 90% 70% at 50% -10%, rgba(var(--met-orange-rgb), 0.14), transparent 55%),
                radial-gradient(ellipse 60% 50% at 100% 100%, rgba(var(--met-orange-rgb), 0.08), transparent 50%),
                linear-gradient(180deg, #ffffff 0%, #f6f7f9 48%, #f0f2f5 100%);
        }

        .met-entry-bg-pattern {
            position: absolute;
            inset: 0;
            opacity: 0.35;
            background-image: radial-gradient(rgba(var(--met-orange-rgb), 0.07) 1px, transparent 1px);
            background-size: 24px 24px;
            mask-image: radial-gradient(ellipse 80% 70% at 50% 40%, #000 20%, transparent 75%);
        }

        .met-entry-content {
            position: relative;
            z-index: 2;
            width: min(92vw, 400px);
        }

        .met-entry-card {
            background: #ffffff;
            border-radius: 20px;
            border: 1px solid rgba(0, 0, 0, 0.06);
            box-shadow:
                0 4px 24px rgba(0, 0, 0, 0.06),
                0 0 0 1px rgba(var(--met-orange-rgb), 0.06);
            padding: 40px 32px 36px;
            text-align: center;
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
            animation: metEntryFadeOut 0.4s ease forwards;
        }

        .met-entry-phase-enter {
            animation: metEntryFadeIn 0.5s ease forwards;
        }

        @keyframes metEntryFadeOut {
            to { opacity: 0; transform: scale(0.98) translateY(-6px); }
        }

        @keyframes metEntryFadeIn {
            from { opacity: 0; transform: scale(0.96) translateY(10px); }
            to { opacity: 1; transform: scale(1) translateY(0); }
        }

        /* --- 鍵・鍵穴 --- */
        .met-entry-lock-wrap {
            position: relative;
            width: 112px;
            height: 128px;
            margin: 0 auto 4px;
        }

        .met-entry-lock-svg {
            width: 100%;
            height: 100%;
            display: block;
            overflow: visible;
        }

        .met-entry-shackle {
            fill: none;
            stroke: #c5c8ce;
            stroke-width: 7;
            stroke-linecap: round;
            transform-origin: 56px 42px;
            transition: stroke 0.35s ease, transform 0.55s cubic-bezier(0.34, 1.4, 0.64, 1);
        }

        .met-entry-lock-body {
            fill: #f3f4f6;
            stroke: #d8dce3;
            stroke-width: 2;
            transition: fill 0.35s ease, stroke 0.35s ease;
        }

        .met-entry-keyhole-outer {
            fill: #9ca3af;
            transition: fill 0.35s ease;
        }

        .met-entry-keyhole-inner {
            fill: #6b7280;
            transition: fill 0.35s ease;
        }

        .met-entry-key {
            position: absolute;
            left: 50%;
            top: 58%;
            width: 36px;
            height: 72px;
            margin-left: -18px;
            margin-top: -8px;
            transform-origin: 50% 22%;
            opacity: 0;
            transform: translateY(28px) rotate(-35deg);
            transition: none;
            pointer-events: none;
        }

        .met-entry-key svg {
            width: 100%;
            height: 100%;
            display: block;
            filter: drop-shadow(0 2px 4px rgba(0, 0, 0, 0.12));
        }

        .met-entry-key-bit {
            fill: var(--met-orange);
        }

        .met-entry-key-shaft {
            fill: #e5e7eb;
            stroke: #d1d5db;
            stroke-width: 1;
        }

        .met-entry-lock-wrap.is-verifying .met-entry-key {
            opacity: 1;
            animation: metEntryKeyApproach 1.8s ease-in-out infinite;
        }

        .met-entry-lock-wrap.is-verifying .met-entry-keyhole-outer {
            fill: #b0b5bd;
            animation: metEntryKeyholePulse 1.8s ease-in-out infinite;
        }

        @keyframes metEntryKeyApproach {
            0%, 100% { transform: translateY(22px) rotate(-40deg); opacity: 0.55; }
            50% { transform: translateY(6px) rotate(-12deg); opacity: 1; }
        }

        @keyframes metEntryKeyholePulse {
            0%, 100% { fill: #b0b5bd; }
            50% { fill: rgba(var(--met-orange-rgb), 0.55); }
        }

        .met-entry-lock-wrap.is-unlocking .met-entry-key {
            opacity: 1;
            animation: metEntryKeyTurn 0.85s cubic-bezier(0.34, 1.2, 0.64, 1) forwards;
        }

        @keyframes metEntryKeyTurn {
            0% { transform: translateY(8px) rotate(-12deg); opacity: 1; }
            35% { transform: translateY(4px) rotate(0deg); }
            100% { transform: translateY(4px) rotate(78deg); opacity: 1; }
        }

        .met-entry-lock-wrap.is-unlocking .met-entry-shackle {
            stroke: var(--met-orange);
            transform: translateY(-14px) rotate(-8deg);
        }

        .met-entry-lock-wrap.is-unlocking .met-entry-lock-body {
            fill: rgba(var(--met-orange-rgb), 0.08);
            stroke: var(--met-orange);
        }

        .met-entry-lock-wrap.is-unlocking .met-entry-keyhole-outer,
        .met-entry-lock-wrap.is-unlocked .met-entry-keyhole-outer {
            fill: var(--met-orange);
        }

        .met-entry-lock-wrap.is-unlocking .met-entry-keyhole-inner,
        .met-entry-lock-wrap.is-unlocked .met-entry-keyhole-inner {
            fill: #fff;
        }

        .met-entry-lock-wrap.is-unlocked .met-entry-shackle {
            stroke: var(--met-orange);
            transform: translateY(-16px) rotate(-10deg);
        }

        .met-entry-lock-wrap.is-unlocked .met-entry-lock-body {
            fill: rgba(var(--met-orange-rgb), 0.1);
            stroke: var(--met-orange);
        }

        .met-entry-lock-wrap.is-unlocked .met-entry-key {
            opacity: 1;
            transform: translateY(4px) rotate(78deg);
        }

        .met-entry-lock-glow {
            position: absolute;
            inset: -20%;
            border-radius: 50%;
            background: radial-gradient(circle, rgba(var(--met-orange-rgb), 0.25), transparent 65%);
            opacity: 0;
            pointer-events: none;
            transition: opacity 0.4s ease;
        }

        .met-entry-lock-wrap.is-unlocking .met-entry-lock-glow,
        .met-entry-lock-wrap.is-unlocked .met-entry-lock-glow {
            opacity: 1;
            animation: metEntryGlowPop 0.7s ease forwards;
        }

        @keyframes metEntryGlowPop {
            0% { transform: scale(0.6); opacity: 0; }
            50% { opacity: 1; }
            100% { transform: scale(1.1); opacity: 0.35; }
        }

        .met-entry-status {
            font-size: 1.05rem;
            font-weight: 600;
            letter-spacing: 0.06em;
            color: #374151;
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
            color: #9ca3af;
            margin: -8px 0 0;
            letter-spacing: 0.02em;
        }

        .met-entry-status.is-unlocked {
            color: var(--met-orange);
        }

        /* --- Welcome --- */
        .met-entry-welcome-label {
            font-size: clamp(2.2rem, 9vw, 3.5rem);
            font-weight: 800;
            line-height: 1.1;
            letter-spacing: -0.02em;
            color: var(--met-orange);
            animation: metEntryWelcomePop 0.75s cubic-bezier(0.22, 1.2, 0.36, 1) forwards;
            transform: scale(0.5);
            opacity: 0;
            margin: 0;
        }

        @keyframes metEntryWelcomePop {
            to { transform: scale(1); opacity: 1; }
        }

        .met-entry-welcome-name {
            font-size: clamp(1.1rem, 4vw, 1.5rem);
            font-weight: 600;
            color: #1f2937;
            animation: metEntryNameIn 0.6s ease 0.25s both;
            margin: 0;
        }

        @keyframes metEntryNameIn {
            from { opacity: 0; transform: translateY(14px); }
            to { opacity: 1; transform: translateY(0); }
        }

        .met-entry-welcome-sub {
            font-size: 0.88rem;
            color: #9ca3af;
            letter-spacing: 0.06em;
            animation: metEntryNameIn 0.6s ease 0.4s both;
            margin: 0;
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
            width: 30%;
            background: linear-gradient(90deg, transparent, var(--met-orange), transparent);
            animation: metEntryProgressSlide 1.8s ease-in-out infinite;
        }

        @keyframes metEntryProgressSlide {
            0% { transform: translateX(-120%); }
            100% { transform: translateX(380%); }
        }
    `;
    document.head.appendChild(style);
}

/** 鍵・鍵穴 SVG マークアップ */
const LOCK_SVG = `
    <svg class="met-entry-lock-svg" viewBox="0 0 112 128" aria-hidden="true">
        <path class="met-entry-shackle" d="M 28 52 A 28 28 0 0 1 84 52 L 84 62" />
        <rect class="met-entry-lock-body" x="22" y="58" width="68" height="58" rx="10" />
        <circle class="met-entry-keyhole-outer" cx="56" cy="82" r="11" />
        <rect class="met-entry-keyhole-inner" x="52" y="82" width="8" height="18" rx="2" />
    </svg>
`;

const KEY_SVG = `
    <svg viewBox="0 0 36 72" aria-hidden="true">
        <circle class="met-entry-key-bit" cx="18" cy="14" r="11" />
        <rect class="met-entry-key-bit" x="14" y="22" width="8" height="6" rx="1" />
        <rect class="met-entry-key-shaft" x="15" y="26" width="6" height="38" rx="2" />
        <rect class="met-entry-key-shaft" x="15" y="56" width="10" height="4" rx="1" />
        <rect class="met-entry-key-shaft" x="15" y="62" width="8" height="3" rx="1" />
    </svg>
`;

/**
 * 全画面オーバーレイを生成する
 * @returns {HTMLElement}
 */
function createOverlay() {
    const overlay = document.createElement('div');
    overlay.className = 'met-entry-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-live', 'polite');

    overlay.innerHTML = `
        <div class="met-entry-bg" aria-hidden="true"></div>
        <div class="met-entry-bg-pattern" aria-hidden="true"></div>
        <div class="met-entry-content">
            <div class="met-entry-card">
                <div class="met-entry-phase met-entry-auth">
                    <div class="met-entry-lock-wrap is-verifying">
                        <div class="met-entry-lock-glow" aria-hidden="true"></div>
                        ${LOCK_SVG}
                        <div class="met-entry-key" aria-hidden="true">${KEY_SVG}</div>
                    </div>
                    <p class="met-entry-status met-entry-status-dots">認証中</p>
                    <p class="met-entry-status-sub">接続を確認しています</p>
                </div>
                <div class="met-entry-phase met-entry-welcome" hidden>
                    <p class="met-entry-welcome-label">Welcome!</p>
                    <p class="met-entry-welcome-name"></p>
                    <p class="met-entry-welcome-sub">メタバースに入ります</p>
                </div>
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
 * 認証成功時に鍵が開くアニメーションを再生する
 * @param {HTMLElement} overlay
 */
async function playUnlockAnimation(overlay) {
    const lockWrap = overlay.querySelector('.met-entry-lock-wrap');
    const statusEl = overlay.querySelector('.met-entry-status');
    const subEl = overlay.querySelector('.met-entry-status-sub');
    if (!lockWrap) return;

    lockWrap.classList.remove('is-verifying');
    lockWrap.classList.add('is-unlocking');

    if (statusEl) {
        statusEl.classList.remove('met-entry-status-dots');
        statusEl.textContent = '認証完了';
        statusEl.classList.add('is-unlocked');
    }
    if (subEl) subEl.textContent = '鍵が開きました';

    await delay(UNLOCK_ANIM_MS);
    lockWrap.classList.remove('is-unlocking');
    lockWrap.classList.add('is-unlocked');
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
    await delay(380);
    authPhase.hidden = true;
    authPhase.classList.remove('met-entry-phase-exit');
    if (nameEl) nameEl.textContent = displayName;
    welcomePhase.hidden = false;
    welcomePhase.classList.add('met-entry-phase-enter');
}

/**
 * 認証 → 鍵開錠 → Welcome → 遷移
 * @param {{
 *   displayName: string,
 *   theme?: LoginEntryTheme,
 *   authTask: () => Promise<unknown>,
 *   onAuthFailed?: (err: unknown) => void,
 *   redirectUrl: string,
 *   preloadStart?: () => Promise<void>,
 * }} options
 * @returns {Promise<boolean>}
 */
export async function runLoginEntryTransition(options) {
    const {
        displayName,
        authTask,
        onAuthFailed,
        redirectUrl,
        preloadStart,
    } = options;

    recordLoginEntryClick();
    ensureTransitionStyles();

    const overlay = createOverlay();
    document.body.appendChild(overlay);
    document.body.style.overflow = 'hidden';

    const authStartedAt = Date.now();
    let resolvedDisplayName = displayName;

    const preloadPromise = typeof preloadStart === 'function' ? preloadStart() : Promise.resolve();

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
        await playUnlockAnimation(overlay);
    } catch (err) {
        teardownOverlay(overlay);
        onAuthFailed?.(err);
        return false;
    }

    await preloadPromise.catch(() => {});

    if (isLoginPreloadFresh()) {
        teardownOverlay(overlay);
        window.location.href = redirectUrl;
        return true;
    }

    const authElapsed = Date.now() - authStartedAt;
    await delay(Math.max(0, AUTH_PHASE_MIN_MS - authElapsed));

    await switchToWelcomePhase(overlay, resolvedDisplayName);
    await delay(WELCOME_PHASE_MS);

    window.location.href = redirectUrl;
    return true;
}
