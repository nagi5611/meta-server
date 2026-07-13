// public/js/entry-welcome-messages.js — 入場 Welcome 文言（4・11・13 以外）

/** @typedef {{ lead: string, body: string, closing: string }} EntryWelcomeMessage */

/** @type {EntryWelcomeMessage[]} */
export const ENTRY_WELCOME_MESSAGES = [
    {
        lead: 'Welcome!!',
        body: 'ここから先は、あなただけの物語。',
        closing: '松山南の空の下、世界の始まりです！',
    },
    {
        lead: 'Welcome!!',
        body: '一歩踏み出したその瞬間、',
        closing: '新しい世界の始まりです！',
    },
    {
        lead: 'Welcome!!',
        body: '扉を開けた先に広がるのは、',
        closing: 'みんなでつくる世界の始まりです！',
    },
    {
        lead: 'Welcome!!',
        body: '友だちと出会い、声が重なる場所。',
        closing: 'ここが、みんなの世界の始まりです！',
    },
    {
        lead: 'Welcome!!',
        body: '顔を合わせられなくても、ここなら会える。',
        closing: 'つながる世界の始まりです！',
    },
    {
        lead: 'Welcome!!',
        body: '風の音、遠くの笑い声、まだ見ぬ景色。',
        closing: 'すべてが、世界の始まりです！',
    },
    {
        lead: 'Welcome!!',
        body: 'スポーン地点の空気が、少しだけ変わった。',
        closing: 'あなたの世界の始まりです！',
    },
    {
        lead: 'Welcome!!',
        body: '地図にない場所へ。',
        closing: 'ここから、世界の始まりです！',
    },
    {
        lead: 'Welcome!!',
        body: 'アバター準備OK、ネットワーク接続OK。',
        closing: 'いよいよ、世界の始まりです！',
    },
    {
        lead: 'Welcome!!',
        body: '今日も誰かが、ここに降り立つ。',
        closing: 'その瞬間が、世界の始まりです！',
    },
    {
        lead: 'Welcome!!',
        body: '',
        closing: 'みんなでメタ、世界の始まりです！',
    },
    {
        lead: 'Welcome!!',
        body: '',
        closing: 'ここから、世界の始まりです！',
    },
];

/**
 * 入場 Welcome 文言をランダムに1件選ぶ
 * @returns {EntryWelcomeMessage}
 */
export function pickRandomEntryWelcomeMessage() {
    const i = Math.floor(Math.random() * ENTRY_WELCOME_MESSAGES.length);
    return ENTRY_WELCOME_MESSAGES[i];
}

/** Welcome オーバーレイ用 CSS（#met-entry-welcome-root 配下） */
export const ENTRY_WELCOME_OVERLAY_CSS = `
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

/**
 * Welcome メッセージ DOM をオーバーレイに描画する
 * @param {HTMLElement} root
 * @param {EntryWelcomeMessage} message
 */
export function renderEntryWelcomeMessage(root, message) {
    let inner = root.querySelector('.met-entry-welcome-inner');
    if (!inner) {
        root.textContent = '';
        inner = document.createElement('div');
        inner.className = 'met-entry-welcome-inner';
        root.appendChild(inner);
    }

    inner.textContent = '';

    const lead = document.createElement('p');
    lead.className = 'met-entry-welcome-lead';
    lead.textContent = message.lead;

    const body = document.createElement('p');
    body.className = 'met-entry-welcome-body';
    body.textContent = message.body || '';

    const closing = document.createElement('p');
    closing.className = 'met-entry-welcome-closing';
    closing.textContent = message.closing;

    inner.append(lead, body, closing);
}

/**
 * sessionStorage 用オブジェクトからメッセージを復元する
 * @param {Record<string, unknown>} data
 * @returns {EntryWelcomeMessage | null}
 */
export function entryWelcomeMessageFromStorage(data) {
    if (!data || typeof data !== 'object') return null;
    const lead = typeof data.welcomeLead === 'string' ? data.welcomeLead : '';
    const closing = typeof data.welcomeClosing === 'string' ? data.welcomeClosing : '';
    if (!lead || !closing) return null;
    return {
        lead,
        body: typeof data.welcomeBody === 'string' ? data.welcomeBody : '',
        closing,
    };
}
