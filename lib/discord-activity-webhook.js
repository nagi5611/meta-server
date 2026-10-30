// lib/discord-activity-webhook.js — ログイン・ログアウト・チャット・起動停止を Discord へ（平文、console 用とは別 URL）

const DISCORD_CONTENT_MAX = 2000;

/** @returns {string} */
function activityServiceLabel() {
  return (
    process.env.PROXY_SERVICE_DOMAIN?.trim() ||
    process.env.METAVERSE_ACTIVITY_SERVICE_LABEL?.trim() ||
    "metaverse"
  );
}

/**
 * @param {'login' | 'logout' | 'chat' | 'player_join' | 'server_start' | 'server_stop'} eventType
 * @param {{
 *   userId?: string;
 *   userName?: string;
 *   chatMessage?: string;
 *   chatWarning?: boolean;
 *   chatWarningCount?: number;
 *   room?: string;
 *   detail?: string;
 * }} [fields]
 * @returns {string | null}
 */
function buildActivityContent(eventType, fields = {}) {
  const url = (process.env.METAVERSE_ACTIVITY_DISCORD_WEBHOOK_URL || "").trim();
  if (!url) return null;

  const label = activityServiceLabel();
  /** @type {string[]} */
  let lines;

  if (eventType === "server_start") {
    lines = ["✅ サーバー起動"];
    if (fields.detail) {
      lines.push(`詳細: ${fields.detail}`);
    }
  } else if (eventType === "server_stop") {
    lines = ["❌ サーバー停止"];
    if (fields.detail) {
      lines.push(`詳細: ${fields.detail}`);
    }
  } else if (eventType === "player_join") {
    const userName = String(fields.userName ?? "").trim() || "Guest";
    const room = String(fields.room ?? "").trim() || "—";
    return `(参加) ${userName} ルーム ${room}`.slice(0, DISCORD_CONTENT_MAX);
  } else if (eventType === "chat") {
    const userId = String(fields.userId ?? "").trim() || "—";
    const chatMessage = String(fields.chatMessage ?? "").trim() || "—";
    let text = `(チャット) ${userId} (${chatMessage})`;
    if (fields.chatWarning === true) {
      const count =
        typeof fields.chatWarningCount === "number" &&
        Number.isFinite(fields.chatWarningCount)
          ? Math.max(1, Math.floor(fields.chatWarningCount))
          : 1;
      text += ` 警告あり(${count})`;
    }
    return text.slice(0, DISCORD_CONTENT_MAX);
  } else if (eventType === "logout") {
    const userName = String(fields.userName ?? "").trim() || "Guest";
    return `${userName}が退出しました`.slice(0, DISCORD_CONTENT_MAX);
  } else if (eventType === "login") {
    lines = [`[${label}] ログイン`];
    const userId = String(fields.userId ?? "").trim() || "—";
    const userName = String(fields.userName ?? "").trim() || "—";
    lines.push(`ユーザーID: ${userId}`, `ユーザー名: ${userName}`);

    if (fields.room) {
      lines.push(`ルーム: ${fields.room}`);
    }
  } else {
    lines = [`[${label}] ${eventType}`];
  }

  return lines.join("\n").slice(0, DISCORD_CONTENT_MAX);
}

/**
 * @param {'login' | 'logout' | 'chat' | 'player_join' | 'server_start' | 'server_stop'} eventType
 * @param {Parameters<typeof buildActivityContent>[1]} [fields]
 */
export function notifyDiscordActivity(eventType, fields) {
  const content = buildActivityContent(eventType, fields);
  if (!content) return;

  void postActivityContent(content).catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[discord-activity-webhook] POST error: ${message}`);
  });
}

/**
 * 停止シグナル時など、送信完了を短時間待つ
 * @param {'login' | 'logout' | 'chat' | 'player_join' | 'server_start' | 'server_stop'} eventType
 * @param {Parameters<typeof buildActivityContent>[1]} [fields]
 */
export async function notifyDiscordActivityWait(eventType, fields) {
  const content = buildActivityContent(eventType, fields);
  if (!content) return;
  await postActivityContent(content);
}

/** @param {string} content */
async function postActivityContent(content) {
  const url = (process.env.METAVERSE_ACTIVITY_DISCORD_WEBHOOK_URL || "").trim();
  if (!url) return;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
}

let shutdownSignalsRegistered = false;

/** プロセス終了時にサーバー停止を通知 */
export function registerActivityShutdownSignals() {
  if (shutdownSignalsRegistered) return;
  if (!(process.env.METAVERSE_ACTIVITY_DISCORD_WEBHOOK_URL || "").trim()) {
    return;
  }
  shutdownSignalsRegistered = true;

  for (const signal of ["SIGTERM", "SIGINT"]) {
    process.once(signal, () => {
      void notifyDiscordActivityWait("server_stop", { detail: signal });
    });
  }
}
