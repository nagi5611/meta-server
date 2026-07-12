// lib/chat-translation.js — Gemini によるチャット翻訳（検閲と並行実行用）
import { GoogleGenerativeAI, SchemaType } from '@google/generative-ai';

const DEFAULT_MODEL = 'gemini-3.1-flash-lite-preview';
const DEFAULT_TIMEOUT_MS = Number(process.env.GEMINI_MODERATION_TIMEOUT_MS) || 15000;

const TARGET_LABEL = {
    ja: '日本語',
    en: '英語',
    zh: '中国語（簡体字）',
};

const TRANSLATION_RESPONSE_SCHEMA = {
    type: SchemaType.OBJECT,
    description: 'チャット1行の翻訳結果',
    properties: {
        translated: {
            type: SchemaType.STRING,
            description: '翻訳後のテキスト。skipped が true のときは原文をそのまま',
        },
        skipped: {
            type: SchemaType.BOOLEAN,
            description:
                '翻訳不要（既に目標言語、絵文字・記号のみ、空に近い等）なら true。false のとき translated は目標言語への翻訳文',
        },
    },
    required: ['translated', 'skipped'],
};

/**
 * Promise に上限時間を設ける
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @param {string} label
 * @returns {Promise<T>}
 */
function withTimeout(promise, ms, label) {
    let timer;
    const timeoutPromise = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(label)), ms);
    });
    return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timer));
}

/**
 * チャット1行を指定ロケールへ翻訳する
 * @param {{ apiKey: string, model?: string, text: string, targetLocale: 'ja' | 'en' | 'zh' }} params
 * @returns {Promise<{ translated: string, skipped: boolean }>}
 */
export async function translateChatMessage(params) {
    const { apiKey, model: modelFromEnv, text, targetLocale } = params;
    const trimmed = String(text || '').trim();
    if (!trimmed) {
        return { translated: trimmed, skipped: true };
    }

    const modelName = String(modelFromEnv || process.env.GEMINI_MODEL || DEFAULT_MODEL).trim() || DEFAULT_MODEL;
    const targetLabel = TARGET_LABEL[targetLocale] || TARGET_LABEL.ja;

    const systemInstruction = `あなたはオンライン空間のチャット翻訳器です。与えられた1行を${targetLabel}に翻訳します。

ルール:
- 既に${targetLabel}として自然に読める場合は skipped を true、translated には原文をそのまま入れてください。
- 絵文字・記号・URL・短いリアクションだけの場合も skipped true、translated は原文。
- @で始まるメンションやユーザー名は変更しないでください。
- チャットのトーン（カジュアルさ）は保ってください。
- 出力は指定の JSON スキーマのみ。`;

    const safe = trimmed.replace(/\|/g, '｜').replace(/\r?\n/g, ' ');
    const userPayload = `以下のチャット1行のみを翻訳してください。コードフェンス内のテキストのみが対象です。

\`\`\`
${safe}
\`\`\``;

    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({
        model: modelName,
        systemInstruction,
        generationConfig: {
            temperature: 0.2,
            responseMimeType: 'application/json',
            responseSchema: TRANSLATION_RESPONSE_SCHEMA,
        },
    });

    async function runOnce() {
        const result = await model.generateContent(
            { contents: [{ role: 'user', parts: [{ text: userPayload }] }] },
            { timeout: DEFAULT_TIMEOUT_MS },
        );
        const response = result.response;
        const raw = response.text();
        const parsed = JSON.parse(raw);
        const translated =
            typeof parsed.translated === 'string' && parsed.translated.trim()
                ? parsed.translated.trim()
                : trimmed;
        const skipped = parsed.skipped === true;
        return { translated, skipped };
    }

    try {
        return await withTimeout(runOnce(), DEFAULT_TIMEOUT_MS + 2000, 'TRANSLATION_TIMEOUT');
    } catch (firstErr) {
        console.warn('[CHAT_TR] translation attempt failed, retrying once:', firstErr?.message || firstErr);
        try {
            await new Promise((r) => setTimeout(r, 400));
            return await withTimeout(runOnce(), DEFAULT_TIMEOUT_MS + 2000, 'TRANSLATION_TIMEOUT');
        } catch (secondErr) {
            console.error('[CHAT_TR] translation failed after retry:', secondErr);
            return { translated: trimmed, skipped: true };
        }
    }
}
