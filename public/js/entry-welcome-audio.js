// public/js/entry-welcome-audio.js — Welcome 演出用 BGM（/music/login.mp3）

const LOGIN_MUSIC_SRC = '/music/login.mp3';
const WELCOME_MUSIC_VOLUME = 0.85;

/** Welcome 表示から BGM 再生までの遅延（ms） */
export const WELCOME_MUSIC_START_DELAY_MS = 500;

/** @type {HTMLAudioElement | null} */
let welcomeAudio = null;

/**
 * 共有 Audio インスタンスを取得または生成する
 * @returns {HTMLAudioElement}
 */
function getWelcomeAudio() {
    if (welcomeAudio) return welcomeAudio;
    if (window.__metWelcomeMusic instanceof HTMLAudioElement) {
        welcomeAudio = window.__metWelcomeMusic;
        return welcomeAudio;
    }
    welcomeAudio = new Audio(LOGIN_MUSIC_SRC);
    welcomeAudio.preload = 'auto';
    welcomeAudio.loop = false;
    welcomeAudio.volume = WELCOME_MUSIC_VOLUME;
    window.__metWelcomeMusic = welcomeAudio;
    return welcomeAudio;
}

/**
 * 予約済みの再生タイマーを解除する
 */
function clearWelcomeMusicStartTimer() {
    const timerId = window.__metWelcomeMusicPlayTimer;
    if (timerId == null) return;
    window.clearTimeout(timerId);
    window.__metWelcomeMusicPlayTimer = null;
}

/**
 * ログイン操作直後など、ユーザー操作の文脈で音声を読み込む
 */
export function primeEntryWelcomeMusic() {
    const audio = getWelcomeAudio();
    if (audio.readyState < HTMLMediaElement.HAVE_METADATA) {
        audio.load();
    }
}

/**
 * Welcome 表示時に BGM を即時再生する
 */
export function startEntryWelcomeMusic() {
    const audio = getWelcomeAudio();
    if (!audio.paused) return;

    audio.currentTime = 0;
    void audio.play().catch(() => {
        /* 自動再生ポリシーで拒否された場合は無視 */
    });
}

/**
 * Welcome 表示から少し遅れて BGM を再生する
 * @param {number} [delayMs]
 */
export function scheduleEntryWelcomeMusic(delayMs = WELCOME_MUSIC_START_DELAY_MS) {
    clearWelcomeMusicStartTimer();
    primeEntryWelcomeMusic();

    window.__metWelcomeMusicPlayTimer = window.setTimeout(() => {
        window.__metWelcomeMusicPlayTimer = null;
        startEntryWelcomeMusic();
    }, Math.max(0, delayMs));
}

/**
 * Welcome 表示時刻（window.__metWelcomeVisibleAt）から 0.5 秒後に再生する
 */
export function scheduleEntryWelcomeMusicAfterWelcomeShown() {
    const visibleAt =
        typeof window.__metWelcomeVisibleAt === 'number' ? window.__metWelcomeVisibleAt : Date.now();
    if (typeof window.__metWelcomeVisibleAt !== 'number') {
        window.__metWelcomeVisibleAt = visibleAt;
    }
    const elapsed = Date.now() - visibleAt;
    const delayMs = Math.max(0, WELCOME_MUSIC_START_DELAY_MS - elapsed);
    scheduleEntryWelcomeMusic(delayMs);
}

/**
 * Welcome 終了時に BGM を止める
 */
export function stopEntryWelcomeMusic() {
    clearWelcomeMusicStartTimer();

    const audio = welcomeAudio || window.__metWelcomeMusic;
    if (!(audio instanceof HTMLAudioElement)) return;
    audio.pause();
    audio.currentTime = 0;
    welcomeAudio = null;
    delete window.__metWelcomeMusic;
}

/**
 * 非モジュール（early スクリプト）向けのグローバル登録
 */
export function installEntryWelcomeAudioGlobals() {
    window.metPrimeWelcomeMusic = primeEntryWelcomeMusic;
    window.metStartWelcomeMusic = startEntryWelcomeMusic;
    window.metScheduleWelcomeMusic = scheduleEntryWelcomeMusic;
    window.metScheduleWelcomeMusicAfterShown = scheduleEntryWelcomeMusicAfterWelcomeShown;
    window.metStopWelcomeMusic = stopEntryWelcomeMusic;
    window.metWelcomeMusicStartDelayMs = WELCOME_MUSIC_START_DELAY_MS;
}

installEntryWelcomeAudioGlobals();
