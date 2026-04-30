// lib/chat-ng-words.js — チャット・表示名の NG ワード一覧（ファイル永続・mtime で再読込）
import fs from 'node:fs';
import path from 'path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DEFAULT_PATH = path.join(__dirname, '..', 'config', 'chat-ng-words.json');
const NG_WORDS_PATH = process.env.CHAT_NG_WORDS_PATH
    ? path.resolve(process.env.CHAT_NG_WORDS_PATH)
    : DEFAULT_PATH;

const MAX_ENTRIES = 500;
const MAX_WORD_LEN = 256;

/** @type {{ phrases: string[], mtimeMs: number }} */
let cache = { phrases: [], mtimeMs: -1 };

/**
 * NG ワード一覧を読み込み（キャッシュ。ファイル変更時のみ再読込）
 * @returns {string[]}
 */
export function getChatNgWords() {
    try {
        if (!fs.existsSync(NG_WORDS_PATH)) {
            cache = { phrases: [], mtimeMs: 0 };
            return [];
        }
        const st = fs.statSync(NG_WORDS_PATH);
        if (cache.mtimeMs !== st.mtimeMs) {
            const rawText = fs.readFileSync(NG_WORDS_PATH, 'utf8');
            const parsed = JSON.parse(rawText);
            const words = Array.isArray(parsed.words) ? parsed.words : [];
            cache.phrases = sanitizeWordList(words);
            cache.mtimeMs = st.mtimeMs;
        }
    } catch (e) {
        console.warn('[chat-ng-words] read failed:', e?.message || e);
        cache = { phrases: [], mtimeMs: 0 };
    }
    return cache.phrases;
}

/**
 * 管理画面保存後に強制的に次回で再読込する
 */
export function invalidateChatNgWordsCache() {
    cache.mtimeMs = -1;
}

/**
 * 正規化（部分一致検出用）
 * @param {string} s
 * @returns {string}
 */
export function normalizeTextForNgMatch(s) {
    return String(s).normalize('NFKC').toLowerCase();
}

/**
 * 禁止フレーズのいずれかが部分一致していれば、その元の語句を返す
 * （長いフレーズを先に検査し、「関連語」になる部分一致も拾う）
 * @param {string} text チャットまたは表示名など
 * @param {string[]|null|undefined} [wordList]
 * @returns {string|null} マッチした登録語句（完全一致表示用）
 */
export function findNgPhraseMatch(text, wordList) {
    const list = Array.isArray(wordList) ? wordList : getChatNgWords();
    const haystack = normalizeTextForNgMatch(text);
    const sorted = [...new Set(list.map((w) => String(w).trim()).filter(Boolean))].sort(
        (a, b) => b.length - a.length,
    );
    for (const phrase of sorted) {
        const n = normalizeTextForNgMatch(phrase);
        if (n.length > 0 && haystack.includes(n)) {
            return phrase;
        }
    }
    return null;
}

/**
 * @param {unknown[]} raw
 * @returns {string[]}
 */
function sanitizeWordList(raw) {
    const out = [];
    const seen = new Set();
    for (const x of raw) {
        const t = typeof x === 'string' ? x.trim().slice(0, MAX_WORD_LEN) : '';
        if (!t) continue;
        const key = normalizeTextForNgMatch(t);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(t);
        if (out.length >= MAX_ENTRIES) break;
    }
    return out;
}

/**
 * NG ワードを保存する（ファイルが無ければ親ディレクトリを作成）
 * @param {unknown[]} rawWords
 */
export function saveChatNgWords(rawWords) {
    const phrases = sanitizeWordList(Array.isArray(rawWords) ? rawWords : []);
    const dir = path.dirname(NG_WORDS_PATH);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(NG_WORDS_PATH, `${JSON.stringify({ words: phrases }, null, 2)}\n`, 'utf8');
    invalidateChatNgWordsCache();
    void getChatNgWords();
}
