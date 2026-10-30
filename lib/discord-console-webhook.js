// lib/discord-console-webhook.js — console 出力を Discord Webhook へコードブロック送信

const DISCORD_CONTENT_MAX = 2000;
const CODE_BLOCK_OVERHEAD = 16;
const BATCH_FLUSH_MS = 2000;
const MAX_BATCH_CHARS = 6000;

/** @type {ReturnType<typeof setTimeout> | null} */
let flushTimer = null;
/** @type {string[]} */
let pendingLines = [];
/** @type {string | null} */
let webhookUrl = null;
/** @type {string} */
let serviceLabel = "metaverse";
/** @type {Record<string, (...args: unknown[]) => void>} */
let originalConsole = {};

/**
 * console.* をフックし、Webhook URL 設定時のみ Discord へバッチ送信する
 * @param {{ webhookUrl?: string; serviceName?: string }} [options]
 */
export function installDiscordConsoleWebhook(options = {}) {
  const url = (options.webhookUrl ?? process.env.METAVERSE_CONSOLE_DISCORD_WEBHOOK_URL ?? "").trim();
  if (!url) return;

  webhookUrl = url;
  serviceLabel =
    options.serviceName?.trim() ||
    process.env.PROXY_SERVICE_DOMAIN?.trim() ||
    process.env.METAVERSE_CONSOLE_SERVICE_LABEL?.trim() ||
    "metaverse";

  originalConsole = {
    log: console.log.bind(console),
    info: console.info.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
    debug: console.debug.bind(console),
  };

  for (const level of ["log", "info", "warn", "error", "debug"]) {
    console[level] = (...args) => {
      originalConsole[level](...args);
      enqueueLine(level, args);
    };
  }

  originalConsole.log(
    `[discord-console-webhook] enabled for ${serviceLabel}`,
  );
}

/**
 * @param {string} level
 * @param {unknown[]} args
 */
function enqueueLine(level, args) {
  const text = formatArgs(args);
  pendingLines.push(`[${level}] ${text}`);
  const joinedLen = pendingLines.join("\n").length;
  if (joinedLen >= MAX_BATCH_CHARS) {
    void flushToDiscord();
    return;
  }
  if (!flushTimer) {
    flushTimer = setTimeout(() => {
      void flushToDiscord();
    }, BATCH_FLUSH_MS);
  }
}

/** @param {unknown[]} args */
function formatArgs(args) {
  return args
    .map((arg) => {
      if (typeof arg === "string") return arg;
      if (arg instanceof Error) {
        return arg.stack || arg.message;
      }
      try {
        return JSON.stringify(arg);
      } catch {
        return String(arg);
      }
    })
    .join(" ");
}

async function flushToDiscord() {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (!webhookUrl || pendingLines.length === 0) return;

  const lines = pendingLines.splice(0, pendingLines.length);
  let body = lines.join("\n");
  const maxBody = DISCORD_CONTENT_MAX - CODE_BLOCK_OVERHEAD - serviceLabel.length - 8;
  if (body.length > maxBody) {
    body = body.slice(-maxBody);
  }

  const content = `\`\`\`text\n[${serviceLabel}]\n${body}\n\`\`\``.slice(
    0,
    DISCORD_CONTENT_MAX,
  );

  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    });
    if (!res.ok) {
      originalConsole.error?.(
        `[discord-console-webhook] POST failed: ${res.status}`,
      );
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    originalConsole.error?.(`[discord-console-webhook] POST error: ${message}`);
  }
}
