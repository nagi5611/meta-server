// public/js/entry-welcome-audio.js — Welcome 演出用 BGM（/music/login.mp3）

const LOGIN_MUSIC_SRC = '/music/login.mp3';
const WELCOME_MUSIC_VOLUME = 0.85;

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
 * ログイン操作直後など、ユーザー操作の文脈で音声を読み込む
 */
export function primeEntryWelcomeMusic() {
    const audio = getWelcomeAudio();
    if (audio.readyState < HTMLMediaElement.HAVE_METADATA) {
        audio.load();
    }
}

/**
 * Welcome 表示時に BGM を再生する
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
 * Welcome 終了時に BGM を止める
 */
export function stopEntryWelcomeMusic() {
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
    window.metStopWelcomeMusic = stopEntryWelcomeMusic;
}

installEntryWelcomeAudioGlobals();
